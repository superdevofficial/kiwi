import empty from 'empty-folder';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import mkdirp from 'mkdirp-promise';
import moment from 'moment';
import * as path from 'path';
import { Mutex } from 'async-mutex';
import numeral from 'numeral';
// tslint:disable-next-line
const debug = require('debug')('kiwi');

/**
 * autostart: run queue just after constructor call. (default: false)
 * directory: path of directory where kiwi will create folders
 * delayBetweenJobs: min delay before run next job (setTimeout, default: 0)
 * deleteJobOnSuccess: delete job file when success (default: true)
 * restore: reload queue from file system on start up. Clear queue if false (default: true).
 * retries: max fail retries. 0 = infinite retry. False = no retry. (default: 3)
 * jsonSpacing: stringify indent. (default: 2)
 */
export interface IOption {
  autostart: boolean;
  directory: string;
  delayBetweenJobs: number;
  deleteJobOnSuccess: boolean;
  restore: boolean;
  retries: boolean | number;
  jsonSpacing: number;
}

export interface IJob {
  filename: string;
  filepath: string;
  data: any;
  tryCount: number;
}

/**
 *
 */
export type WorkerFunction = (job: IJob) => any | Promise<any>;

const DIR_NAMES: ReadonlyArray<any> = ['current', 'idle', 'success', 'fail'];

export class Kiwi extends EventEmitter {
  protected static fileId = 0;
  protected static runJobMutex = new Mutex();
  protected static getJobMutex = new Mutex();
  protected options: IOption = {
    autostart: false,
    delayBetweenJobs: 0,
    deleteJobOnSuccess: true,
    directory: './.queue',
    jsonSpacing: 2,
    restore: true,
    retries: 3
  };
  public inited: Promise<void>;
  protected started: boolean = false;
  protected currentJob: IJob | null = null;

  protected currentPath: string;
  protected idlePath: string;
  protected successPath: string;
  protected failPath: string;
  protected paths: string[];

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

    if (this.options.autostart)
      this.start();
  }

  public init(): Promise<void> {
    if (!this.inited) {
      this.inited = this._init();
    }
    return this.inited;
  }

  protected async _init(): Promise<void> {
    debug('start init');
    for (const dir of this.paths) {
      await mkdirp(dir);
    }
    if (!this.options.restore)
      await this._clear();
    debug('end init');
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

  protected async _clear(): Promise<void> {
    for (const dir of this.paths) {
      debug('remove folder ' + dir);
      await this.empty(dir);
    }
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

  public async isEmpty() {
    return (await this.countIdleJobs()) === 0;
  }

  public async countIdleJobs(): Promise<number> {
    const files = await this.getFilesInIdleDirectory();
    return files && files.length || 0;
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
        moment().format('YYYY-MM-DD-HH-mm-ss-') + numeral(Kiwi.fileId).format('00000000000000000000') + '.json'
      );
      exist = await fs.pathExists(filename);
    } while (exist && i < 100);
    if (exist) {
      throw new Error('Unable to find unique file name !');
    }
    debug('get unique filename : ' + filename);
    return filename;
  }

  protected async runNextJob(): Promise<void> {
    let releaseGetJob = await Kiwi.getJobMutex.acquire();
    if (!this.currentJob && this.started) {
      debug('try to run next job');
      const releaseRunJob = await Kiwi.runJobMutex.acquire();
      try {
        const job = await this.getNextJob();
        debug('Get next job', job);
        if (job) {
          this.currentJob = job;
          releaseGetJob();
          releaseGetJob = null;
          await this.runJob(job);
          this.currentJob = null;
        }
      } catch (e) {
        debug('Error while running job', e);
      } finally {
        releaseRunJob();
      }
    } else {
      debug('Run next job invoked but job alreay running');
    }
    if (releaseGetJob)
      releaseGetJob();
  }

  protected async runJob(job: IJob): Promise<void> {
    debug('run job ', job.filename);

    const newFilepath = path.join(this.currentPath, job.filename);
    await fs.move(job.filepath, newFilepath);
    job.filepath = newFilepath;

    job.data = await fs.readJSON(job.filepath);
    job.tryCount = 0;
    let jobResult: any;
    do {
      try {
        jobResult = await this.worker(job);
        debug('job success', job.filename, jobResult);
      } catch (e) {
        debug('job failed', e);
        jobResult = false;
      }
    } while (jobResult === false);

    await fs.remove(job.filepath);

    debug('dispatch job:finished', job.filename);
    this.emit('job:finished', job);
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

  protected async getFilesInIdleDirectory() {
    let files = await fs.readdir(this.idlePath);
    if (files.length === 0) {
      return false;
    }
    return files.filter(x => x.endsWith('.json')).sort();
  }

  protected empty(folderPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      empty(folderPath, false, ({ error/*,failed,removed*/ }) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
