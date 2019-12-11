import { Mutex } from 'async-mutex';
import empty from 'empty-folder';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import mkdirp from 'mkdirp-promise';
import moment from 'moment';
import numeral from 'numeral';
import * as path from 'path';
// tslint:disable-next-line
const debug = require('debug')('kiwi');

export type LogFunction = (message: string, ...data: any) => void;

export interface ILogger {
  debug: LogFunction;
  info: LogFunction;
  warning: LogFunction;
  error: LogFunction;
}

/**
 * Type of Kiwi constructor options.
 */
export interface IOption {
  /** run queue just after constructor call. (default: false) */
  autostart: boolean;
  /** path of directory where kiwi will create folders */
  directory: string;
  /** min delay before run next job (setTimeout, default: 0) */
  delayBetweenJobs: number;
  /** delete job file when fail, otherwise move to fail folder (default: true) */
  deleteJobOnFail: boolean;
  /** delete job file when success, otherwise move to success folder (default: true) */
  deleteJobOnSuccess: boolean;
  /** Allow to pass your own log function or a logger like winston. (default use debug module) */
  logger?: LogFunction | ILogger;
  /** reload queue from file system on start up. Clear queue if false (default: true) */
  restore: boolean;
  /** max fail retries. 0 = infinite retry. False = no retry. (default: 3) */
  retries: boolean | number;
  /** stringify indent. (default: 2) */
  jsonSpacing: number;
}

export interface IJob {
  filename: string;
  filepath: string;
  data: any;
  tryCount: number;
  success?: boolean;
  result?: any;
}

/**
 *
 */
export type WorkerFunction = (job: IJob) => any | Promise<any>;

const DIR_NAMES: ReadonlyArray<any> = ['current', 'idle', 'success', 'fail'];

/**
 * Example :
 * @example
 * ```typescript
 * let counter = 0;
 *
 * const queue = new Kiwi(job => {
 *   counter++;
 * });
 *
 * await queue.clear(); //clean previous jobs
 * await queue.add('foo'); //add job with 'foo' as data
 * queue.start();
 * await queue.idle(); //await queue is empty
 * console.log(await queue.isEmpty()); //check is empty
 * ```
 */
export class Kiwi extends EventEmitter {
  protected static fileId = 0;
  protected static runJobMutex = new Mutex();
  protected static getJobMutex = new Mutex();
  public inited: Promise<void>;
  protected options: IOption = {
    autostart: false,
    delayBetweenJobs: 0,
    deleteJobOnFail: true,
    deleteJobOnSuccess: true,
    directory: './.queue',
    jsonSpacing: 2,
    restore: true,
    retries: 3
  };
  protected started: boolean = false;
  protected currentJob: IJob | null = null;

  protected currentPath: string;
  protected idlePath: string;
  protected successPath: string;
  protected failPath: string;
  protected paths: string[];

  /**
   * @param worker Async function invoked by kiwi on each job. Should throw an exception if job failed.
   * @param options Configure kiwi queue
   */
  constructor(protected worker: WorkerFunction, options?: Partial<IOption>) {
    super();
    Object.assign(this.options, options);

    this.paths = [];
    for (const dir of DIR_NAMES) {
      const folderPath = path.join(this.options.directory, dir);
      this[dir + 'Path'] = folderPath;
      this.paths.push(folderPath);
    }

    this.addListener('job:finished', this.onJobFinished.bind(this));

    if (this.options.autostart) {
      this.start();
    }
  }

  public init(): Promise<void> {
    if (!this.inited) {
      this.inited = this._init();
    }
    return this.inited;
  }

  public async start(): Promise<void> {
    this.started = true;
    await this.init();
    this.runNextJob();
  }

  public async pause(): Promise<void> {
    this.started = false;
  }

  public async clear(): Promise<void> {
    await this.init();
    return this._clear();
  }

  public async idle(): Promise<void> {
    return new Promise(resolve => {
      this.once('queue:idle', resolve);
    });
  }

  public async add(data: any): Promise<void> {
    const filename = await this.getUniqueFilename();
    await fs.writeJSON(filename, data, {
      spaces: this.options.jsonSpacing
    });
    if (this.started) {
      this.runNextJob();
    }
  }

  public async isEmpty(): Promise<boolean> {
    return (await this.countIdleJobs()) === 0;
  }

  public async countIdleJobs(): Promise<number> {
    const files = await this.getFilesInIdleDirectory();
    return (files && files.length) || 0;
  }

  protected async _init(): Promise<void> {
    this.log('debug', 'start init');
    for (const dir of this.paths) {
      await mkdirp(dir);
    }
    if (this.options.restore) {
      await this.restoreCurrentFileIntoIdleDirectory();
    } else {
      await this._clear();
    }
    this.log('debug', 'end init');
  }

  protected async _clear(): Promise<void> {
    for (const dir of this.paths) {
      this.log('info', 'remove folder ' + dir);
      await this.empty(dir);
    }
  }

  protected async getUniqueFilename(): Promise<string> {
    let exist: boolean;
    let filename: string = '';
    let i = 0;
    do {
      i++;
      Kiwi.fileId++;
      filename = path.join(
        this.idlePath,
        moment().format('YYYY-MM-DD-HH-mm-ss-') +
        numeral(Kiwi.fileId).format('00000000000000000000') +
        '.json'
      );
      exist = await fs.pathExists(filename);
    } while (exist && i < 100);
    if (exist) {
      throw new Error('Unable to find unique file name !');
    }
    this.log('debug', 'get unique filename : ' + filename);
    return filename;
  }

  protected async runNextJob(): Promise<void> {
    let releaseGetJob = await Kiwi.getJobMutex.acquire();
    if (!this.currentJob && this.started) {
      this.log('debug', 'try to run next job');
      const releaseRunJob = await Kiwi.runJobMutex.acquire();
      try {
        const job = await this.getNextJob();
        this.log('debug', 'Get next job', job);
        if (job) {
          this.currentJob = job;
          releaseGetJob();
          releaseGetJob = null;
          await this.runJob(job);
          this.currentJob = null;
        }
      } catch (e) {
        this.log('warning', 'Error while running job', e);
      } finally {
        releaseRunJob();
      }
    } else {
      this.log('debug', 'Run next job invoked but job alreay running');
    }
    if (releaseGetJob) {
      releaseGetJob();
    }
  }

  protected async runJob(job: IJob): Promise<void> {
    this.log('debug', 'run job ', job.filename);

    const newFilepath = path.join(this.currentPath, job.filename);
    await fs.move(job.filepath, newFilepath);
    job.filepath = newFilepath;

    job.data = await fs.readJSON(job.filepath);
    job.tryCount = 0;
    do {
      try {
        job.result = await this.worker(job);
        job.success = true;
        this.log('info', 'job success', job.filename, job.result);
      } catch (e) {
        this.log('warning', 'job failed', e);
        job.success = false;
        job.tryCount++;
      }
    } while (
      !job.success &&
      (this.options.retries < 0 || job.tryCount <= this.options.retries)
    );

    await this.cleanJobFile(job);

    this.log('debug', 'dispatch job events', job.filename);
    if (job.success) {
      this.emit('job:success', job);
    } else {
      this.log('error', 'job failed and exceed maximum retry', job);
      this.emit('job:fail', job);
    }
    this.emit('job:finished', job);
  }

  protected async cleanJobFile(job: IJob): Promise<void> {
    const destPath = path.join(
      job.success ? this.successPath : this.failPath,
      job.filename
    );
    const remove = job.success
      ? this.options.deleteJobOnSuccess
      : this.options.deleteJobOnFail;
    if (remove) {
      await fs.remove(job.filepath);
      job.filepath = null;
    } else {
      await fs.move(job.filepath, destPath);
      job.filepath = destPath;
    }
  }

  protected async onJobFinished(): Promise<void> {
    if (await this.isEmpty()) {
      this.emit('queue:idle');
    } else {
      setTimeout(() => {
        this.runNextJob();
      }, this.options.delayBetweenJobs);
    }
  }

  protected async getNextJob(): Promise<IJob | false> {
    const filepath = await this.getNextJobFilePath();
    if (filepath) {
      return {
        data: null,
        filename: path.basename(filepath),
        filepath,
        tryCount: 0
      };
    }
    return false;
  }

  protected async getNextJobFilePath(): Promise<string | false> {
    const files = await this.getFilesInIdleDirectory();
    return files && files.length > 0 && path.join(this.idlePath, files[0]);
  }

  protected async getFilesInCurrentDirectory(): Promise<string[] | false> {
    return this.getFilesInDirectory(this.currentPath);
  }

  protected async getFilesInIdleDirectory(): Promise<string[] | false> {
    return this.getFilesInDirectory(this.idlePath);
  }

  protected async getFilesInDirectory(dir: string): Promise<string[] | false> {
    const files = await fs.readdir(dir);
    if (files.length === 0) {
      return false;
    }
    return files.filter(x => x.endsWith('.json')).sort();
  }

  protected async restoreCurrentFileIntoIdleDirectory(): Promise<void> {
    const files = await this.getFilesInCurrentDirectory();
    if (files && files.length > 0) {
      for (const file of files) {
        await fs.move(
          path.join(this.currentPath, file),
          path.join(this.idlePath, file),
          { overwrite: false }
        );
      }
    }
  }

  protected empty(folderPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      empty(folderPath, false, ({ error /*,failed,removed*/ }) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  protected log(level: keyof ILogger, message: string, ...data: any[]): void {
    let logger: any;
    if (this.options.logger) {
      logger =
        typeof this.options.logger === 'function'
          ? this.options.logger
          : this.options.logger[level];
    }
    logger = logger || debug || (() => { /** noop */ });
    logger(message, data);
  }
}
