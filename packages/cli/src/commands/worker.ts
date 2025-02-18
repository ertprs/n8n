import express from 'express';
import http from 'http';
import type PCancelable from 'p-cancelable';
import { Container } from 'typedi';

import { flags } from '@oclif/command';
import { WorkflowExecute } from 'n8n-core';

import type {
	ExecutionError,
	ExecutionStatus,
	IExecuteResponsePromiseData,
	INodeTypes,
	IRun,
} from 'n8n-workflow';
import {
	Workflow,
	NodeOperationError,
	sleep,
	ApplicationError,
	ErrorReporterProxy as EventReporter,
} from 'n8n-workflow';

import * as Db from '@/Db';
import * as ResponseHelper from '@/ResponseHelper';
import * as WebhookHelpers from '@/WebhookHelpers';
import * as WorkflowExecuteAdditionalData from '@/WorkflowExecuteAdditionalData';
import { PermissionChecker } from '@/UserManagement/PermissionChecker';

import config from '@/config';
import type { Job, JobId, JobResponse, WebhookResponse } from '@/Queue';
import { Queue } from '@/Queue';
import { generateFailedExecutionFromError } from '@/WorkflowHelpers';
import { N8N_VERSION } from '@/constants';
import { BaseCommand } from './BaseCommand';
import { ExecutionRepository } from '@db/repositories/execution.repository';
import { WorkflowRepository } from '@db/repositories/workflow.repository';
import { OwnershipService } from '@/services/ownership.service';
import type { ICredentialsOverwrite } from '@/Interfaces';
import { CredentialsOverwrites } from '@/CredentialsOverwrites';
import { rawBodyReader, bodyParser } from '@/middlewares';
import { eventBus } from '@/eventbus';
import type { RedisServicePubSubSubscriber } from '@/services/redis/RedisServicePubSubSubscriber';
import { EventMessageGeneric } from '@/eventbus/EventMessageClasses/EventMessageGeneric';
import type { IConfig } from '@oclif/config';
import { OrchestrationHandlerWorkerService } from '@/services/orchestration/worker/orchestration.handler.worker.service';
import { OrchestrationWorkerService } from '@/services/orchestration/worker/orchestration.worker.service';
import type { WorkerJobStatusSummary } from '../services/orchestration/worker/types';
import { ServiceUnavailableError } from '@/errors/response-errors/service-unavailable.error';

export class Worker extends BaseCommand {
	static description = '\nStarts a n8n worker';

	static examples = ['$ n8n worker --concurrency=5'];

	static flags = {
		help: flags.help({ char: 'h' }),
		concurrency: flags.integer({
			default: 10,
			description: 'How many jobs can run in parallel.',
		}),
	};

	static runningJobs: {
		[key: string]: PCancelable<IRun>;
	} = {};

	static runningJobsSummary: {
		[jobId: string]: WorkerJobStatusSummary;
	} = {};

	static jobQueue: Queue;

	redisSubscriber: RedisServicePubSubSubscriber;

	/**
	 * Stop n8n in a graceful way.
	 * Make for example sure that all the webhooks from third party services
	 * get removed.
	 */
	async stopProcess() {
		this.logger.info('Stopping n8n...');

		// Stop accepting new jobs
		await Worker.jobQueue.pause(true);

		try {
			await this.externalHooks.run('n8n.stop', []);

			const maxStopTime = config.getEnv('queue.bull.gracefulShutdownTimeout') * 1000;

			const stopTime = new Date().getTime() + maxStopTime;

			setTimeout(async () => {
				// In case that something goes wrong with shutdown we
				// kill after max. 30 seconds no matter what
				await this.exitSuccessFully();
			}, maxStopTime);

			// Wait for active workflow executions to finish
			let count = 0;
			while (Object.keys(Worker.runningJobs).length !== 0) {
				if (count++ % 4 === 0) {
					const waitLeft = Math.ceil((stopTime - new Date().getTime()) / 1000);
					this.logger.info(
						`Waiting for ${
							Object.keys(Worker.runningJobs).length
						} active executions to finish... (wait ${waitLeft} more seconds)`,
					);
				}

				await sleep(500);
			}
		} catch (error) {
			await this.exitWithCrash('There was an error shutting down n8n.', error);
		}

		await this.exitSuccessFully();
	}

	async runJob(job: Job, nodeTypes: INodeTypes): Promise<JobResponse> {
		const { executionId, loadStaticData } = job.data;
		const executionRepository = Container.get(ExecutionRepository);
		const fullExecutionData = await executionRepository.findSingleExecution(executionId, {
			includeData: true,
			unflattenData: true,
		});

		if (!fullExecutionData) {
			this.logger.error(
				`Worker failed to find data of execution "${executionId}" in database. Cannot continue.`,
				{ executionId },
			);
			throw new ApplicationError(
				'Unable to find data of execution in database. Aborting execution.',
				{ extra: { executionId } },
			);
		}
		const workflowId = fullExecutionData.workflowData.id!; // @tech_debt Ensure this is not optional

		if (!workflowId) {
			EventReporter.report('Detected ID-less workflow', {
				level: 'info',
				extra: { execution: fullExecutionData },
			});
		}

		this.logger.info(
			`Start job: ${job.id} (Workflow ID: ${workflowId} | Execution: ${executionId})`,
		);
		await executionRepository.updateStatus(executionId, 'running');

		const workflowOwner = await Container.get(OwnershipService).getWorkflowOwnerCached(workflowId);

		let { staticData } = fullExecutionData.workflowData;
		if (loadStaticData) {
			const workflowData = await Container.get(WorkflowRepository).findOne({
				select: ['id', 'staticData'],
				where: {
					id: workflowId,
				},
			});
			if (workflowData === null) {
				this.logger.error(
					'Worker execution failed because workflow could not be found in database.',
					{ workflowId, executionId },
				);
				throw new ApplicationError('Workflow could not be found', { extra: { workflowId } });
			}
			staticData = workflowData.staticData;
		}

		const workflowSettings = fullExecutionData.workflowData.settings ?? {};

		let workflowTimeout = workflowSettings.executionTimeout ?? config.getEnv('executions.timeout'); // initialize with default

		let executionTimeoutTimestamp: number | undefined;
		if (workflowTimeout > 0) {
			workflowTimeout = Math.min(workflowTimeout, config.getEnv('executions.maxTimeout'));
			executionTimeoutTimestamp = Date.now() + workflowTimeout * 1000;
		}

		const workflow = new Workflow({
			id: workflowId,
			name: fullExecutionData.workflowData.name,
			nodes: fullExecutionData.workflowData.nodes,
			connections: fullExecutionData.workflowData.connections,
			active: fullExecutionData.workflowData.active,
			nodeTypes,
			staticData,
			settings: fullExecutionData.workflowData.settings,
		});

		const additionalData = await WorkflowExecuteAdditionalData.getBase(
			workflowOwner.id,
			undefined,
			executionTimeoutTimestamp,
		);
		additionalData.hooks = WorkflowExecuteAdditionalData.getWorkflowHooksWorkerExecuter(
			fullExecutionData.mode,
			job.data.executionId,
			fullExecutionData.workflowData,
			{
				retryOf: fullExecutionData.retryOf as string,
			},
		);

		try {
			await PermissionChecker.check(workflow, workflowOwner.id);
		} catch (error) {
			if (error instanceof NodeOperationError) {
				const failedExecution = generateFailedExecutionFromError(
					fullExecutionData.mode,
					error,
					error.node,
				);
				await additionalData.hooks.executeHookFunctions('workflowExecuteAfter', [failedExecution]);
			}
			return { success: true, error: error as ExecutionError };
		}

		additionalData.hooks.hookFunctions.sendResponse = [
			async (response: IExecuteResponsePromiseData): Promise<void> => {
				const progress: WebhookResponse = {
					executionId,
					response: WebhookHelpers.encodeWebhookResponse(response),
				};
				await job.progress(progress);
			},
		];

		additionalData.executionId = executionId;

		additionalData.setExecutionStatus = (status: ExecutionStatus) => {
			// Can't set the status directly in the queued worker, but it will happen in InternalHook.onWorkflowPostExecute
			this.logger.debug(`Queued worker execution status for ${executionId} is "${status}"`);
		};

		let workflowExecute: WorkflowExecute;
		let workflowRun: PCancelable<IRun>;
		if (fullExecutionData.data !== undefined) {
			workflowExecute = new WorkflowExecute(
				additionalData,
				fullExecutionData.mode,
				fullExecutionData.data,
			);
			workflowRun = workflowExecute.processRunExecutionData(workflow);
		} else {
			// Execute all nodes
			// Can execute without webhook so go on
			workflowExecute = new WorkflowExecute(additionalData, fullExecutionData.mode);
			workflowRun = workflowExecute.run(workflow);
		}

		Worker.runningJobs[job.id] = workflowRun;
		Worker.runningJobsSummary[job.id] = {
			jobId: job.id.toString(),
			executionId,
			workflowId: fullExecutionData.workflowId ?? '',
			workflowName: fullExecutionData.workflowData.name,
			mode: fullExecutionData.mode,
			startedAt: fullExecutionData.startedAt,
			retryOf: fullExecutionData.retryOf ?? '',
			status: fullExecutionData.status,
		};

		// Wait till the execution is finished
		await workflowRun;

		delete Worker.runningJobs[job.id];
		delete Worker.runningJobsSummary[job.id];

		// do NOT call workflowExecuteAfter hook here, since it is being called from processSuccessExecution()
		// already!

		return {
			success: true,
		};
	}

	constructor(argv: string[], cmdConfig: IConfig) {
		super(argv, cmdConfig);
		this.setInstanceType('worker');
		this.setInstanceQueueModeId();
	}

	async init() {
		await this.initCrashJournal();

		this.logger.debug('Starting n8n worker...');
		this.logger.debug(`Queue mode id: ${this.queueModeId}`);

		await super.init();

		await this.initLicense();
		this.logger.debug('License init complete');
		await this.initBinaryDataService();
		this.logger.debug('Binary data service init complete');
		await this.initExternalHooks();
		this.logger.debug('External hooks init complete');
		await this.initExternalSecrets();
		this.logger.debug('External secrets init complete');
		await this.initEventBus();
		this.logger.debug('Event bus init complete');
		await this.initQueue();
		this.logger.debug('Queue init complete');
		await this.initOrchestration();
		this.logger.debug('Orchestration init complete');

		await Container.get(OrchestrationWorkerService).publishToEventLog(
			new EventMessageGeneric({
				eventName: 'n8n.worker.started',
				payload: {
					workerId: this.queueModeId,
				},
			}),
		);
	}

	async initEventBus() {
		await eventBus.initialize({
			workerId: this.queueModeId,
		});
	}

	/**
	 * Initializes the redis connection
	 * A publishing connection to redis is created to publish events to the event log
	 * A subscription connection to redis is created to subscribe to commands from the main process
	 * The subscription connection adds a handler to handle the command messages
	 */
	async initOrchestration() {
		await Container.get(OrchestrationWorkerService).init();
		await Container.get(OrchestrationHandlerWorkerService).initWithOptions({
			queueModeId: this.queueModeId,
			redisPublisher: Container.get(OrchestrationWorkerService).redisPublisher,
			getRunningJobIds: () => Object.keys(Worker.runningJobs),
			getRunningJobsSummary: () => Object.values(Worker.runningJobsSummary),
		});
	}

	async initQueue() {
		// eslint-disable-next-line @typescript-eslint/no-shadow
		const { flags } = this.parse(Worker);

		const redisConnectionTimeoutLimit = config.getEnv('queue.bull.redis.timeoutThreshold');

		this.logger.debug(
			`Opening Redis connection to listen to messages with timeout ${redisConnectionTimeoutLimit}`,
		);

		Worker.jobQueue = Container.get(Queue);
		await Worker.jobQueue.init();
		this.logger.debug('Queue singleton ready');
		void Worker.jobQueue.process(flags.concurrency, async (job) =>
			this.runJob(job, this.nodeTypes),
		);

		Worker.jobQueue.getBullObjectInstance().on('global:progress', (jobId: JobId, progress) => {
			// Progress of a job got updated which does get used
			// to communicate that a job got canceled.

			if (progress === -1) {
				// Job has to get canceled
				if (Worker.runningJobs[jobId] !== undefined) {
					// Job is processed by current worker so cancel
					Worker.runningJobs[jobId].cancel();
					delete Worker.runningJobs[jobId];
				}
			}
		});

		let lastTimer = 0;
		let cumulativeTimeout = 0;
		Worker.jobQueue.getBullObjectInstance().on('error', (error: Error) => {
			if (error.toString().includes('ECONNREFUSED')) {
				const now = Date.now();
				if (now - lastTimer > 30000) {
					// Means we had no timeout at all or last timeout was temporary and we recovered
					lastTimer = now;
					cumulativeTimeout = 0;
				} else {
					cumulativeTimeout += now - lastTimer;
					lastTimer = now;
					if (cumulativeTimeout > redisConnectionTimeoutLimit) {
						this.logger.error(
							`Unable to connect to Redis after ${redisConnectionTimeoutLimit}. Exiting process.`,
						);
						process.exit(1);
					}
				}
				this.logger.warn('Redis unavailable - trying to reconnect...');
			} else if (error.toString().includes('Error initializing Lua scripts')) {
				// This is a non-recoverable error
				// Happens when worker starts and Redis is unavailable
				// Even if Redis comes back online, worker will be zombie
				this.logger.error('Error initializing worker.');
				process.exit(2);
			} else {
				this.logger.error('Error from queue: ', error);
				throw error;
			}
		});
	}

	async setupHealthMonitor() {
		const port = config.getEnv('queue.health.port');

		const app = express();
		app.disable('x-powered-by');

		const server = http.createServer(app);

		app.get(
			'/healthz',

			async (req: express.Request, res: express.Response) => {
				this.logger.debug('Health check started!');

				const connection = Db.getConnection();

				try {
					if (!connection.isInitialized) {
						// Connection is not active
						throw new ApplicationError('No active database connection');
					}
					// DB ping
					await connection.query('SELECT 1');
				} catch (e) {
					this.logger.error('No Database connection!', e as Error);
					const error = new ServiceUnavailableError('No Database connection!');
					return ResponseHelper.sendErrorResponse(res, error);
				}

				// Just to be complete, generally will the worker stop automatically
				// if it loses the connection to redis
				try {
					// Redis ping
					await Worker.jobQueue.ping();
				} catch (e) {
					this.logger.error('No Redis connection!', e as Error);
					const error = new ServiceUnavailableError('No Redis connection!');
					return ResponseHelper.sendErrorResponse(res, error);
				}

				// Everything fine
				const responseData = {
					status: 'ok',
				};

				this.logger.debug('Health check completed successfully!');

				ResponseHelper.sendSuccessResponse(res, responseData, true, 200);
			},
		);

		let presetCredentialsLoaded = false;
		const endpointPresetCredentials = config.getEnv('credentials.overwrite.endpoint');
		if (endpointPresetCredentials !== '') {
			// POST endpoint to set preset credentials
			app.post(
				`/${endpointPresetCredentials}`,
				rawBodyReader,
				bodyParser,
				async (req: express.Request, res: express.Response) => {
					if (!presetCredentialsLoaded) {
						const body = req.body as ICredentialsOverwrite;

						if (req.contentType !== 'application/json') {
							ResponseHelper.sendErrorResponse(
								res,
								new Error(
									'Body must be a valid JSON, make sure the content-type is application/json',
								),
							);
							return;
						}

						Container.get(CredentialsOverwrites).setData(body);
						presetCredentialsLoaded = true;
						ResponseHelper.sendSuccessResponse(res, { success: true }, true, 200);
					} else {
						ResponseHelper.sendErrorResponse(res, new Error('Preset credentials can be set once'));
					}
				},
			);
		}

		server.on('error', (error: Error & { code: string }) => {
			if (error.code === 'EADDRINUSE') {
				this.logger.error(
					`n8n's port ${port} is already in use. Do you have the n8n main process running on that port?`,
				);
				process.exit(1);
			}
		});

		await new Promise<void>((resolve) => server.listen(port, () => resolve()));
		await this.externalHooks.run('worker.ready');
		this.logger.info(`\nn8n worker health check via, port ${port}`);
	}

	async run() {
		// eslint-disable-next-line @typescript-eslint/no-shadow
		const { flags } = this.parse(Worker);

		this.logger.info('\nn8n worker is now ready');
		this.logger.info(` * Version: ${N8N_VERSION}`);
		this.logger.info(` * Concurrency: ${flags.concurrency}`);
		this.logger.info('');

		if (config.getEnv('queue.health.active')) {
			await this.setupHealthMonitor();
		}

		// Make sure that the process does not close
		await new Promise(() => {});
	}

	async catch(error: Error) {
		await this.exitWithCrash('Worker exiting due to an error.', error);
	}
}
