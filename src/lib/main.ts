import empty from 'empty-folder';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import mkdirp from 'mkdirp-promise';
import moment from 'moment';
import * as path from 'path';
// tslint:disable-next-line
const debug = require('debug')('kiwi');

/**
 * directory: path of directory where kiwi will create folders
 * deleteJobOnSuccess: delete job file when success (default: true)
 * retries: max fail retries. 0 = infinite retry. False = no retry. (default: 3)
 * jsonSpacing: stringify indent. (default: 2)
 */
export interface IOption {
  directory: string;
  deleteJobOnSuccess: boolean;
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
  protected options: IOption = {
    deleteJobOnSuccess: true,
    directory: './.queue',
    jsonSpacing: 2,
    retries: 3
  };
  protected inited: boolean = false;
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
  }

  public async init(): Promise<void> {
    if (!this.inited) {
      for (const dir of this.paths) {
        await mkdirp(dir);
      }
      this.inited = true;
    }
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
    for (const dir of this.paths) {
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
      filename = path.join(
        this.idlePath,
        moment().format('YYYY-MM-DD-HH-mm-ss-') + i + '.json'
      );
      i++;
      exist = await fs.pathExists(filename);
    } while (exist && i < 100);
    if (exist) {
      throw new Error('Unable to find unique file name !');
    }
    return filename;
  }

  protected async runNextJob(): Promise<void> {
    if (!this.currentJob && this.started) {
      const job = await this.getNextJob();
      if (job) {
        await this.runJob(job);
      }
    }
  }

  protected async runJob(job: IJob): Promise<void> {
    if (this.currentJob) {
      throw new Error('Cannot run job, a job already running');
    }
    const newFilepath = path.join(this.currentPath, job.filename);
    await fs.move(job.filepath, newFilepath);
    job.filepath = newFilepath;
    this.currentJob = job;

    job.data = await fs.readJSON(job.filepath);
    job.tryCount = 0;
    let jobResult: any;
    do {
      try {
        jobResult = await this.worker(job);
      } catch (e) {
        debug('job failed', e);
        jobResult = false;
      }
    } while (jobResult === false);

    await fs.remove(job.filepath);

    this.currentJob = null;
    this.emit('job:finished', job);
  }

  protected async onJobFinished(): Promise<void> {
    if (await this.isEmpty()) {
      this.emit('queue:idle');
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
