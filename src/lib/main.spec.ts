// tslint:disable:no-expression-statement
import test from 'ava';
import fs from 'fs-extra';
import { Kiwi } from './main';

test.serial('should run one task', async t => {
  let counter = 0;

  const queue = new Kiwi(job => {
    counter++;
    t.is(counter, 1);
    t.is(job.data, 'foo');
    t.truthy(job.filename);
    t.pass();
  });

  await queue.clear();
  await queue.add('foo');
  queue.start();
  await queue.idle();
  t.true(await queue.isEmpty());
});

test.serial('should keep task order', async t => {
  const max = 100;
  let counter = 1;
  t.timeout(max * 100);

  const queue = new Kiwi(job => {
    t.is(job.data, counter);
    if (job.data === max)
      t.pass();
    else
      counter++;
  });

  await queue.clear();
  for (let i = 1; i < max; i++) {
    queue.add(i);
  }
  queue.start();
  await queue.idle();
  t.is(counter, max);
});

test.serial('should auto start', async t => {
  const max = 4;
  let counter = 1;

  const queue = new Kiwi(job => {
    t.is(job.data, counter);
    if (job.data === max)
      t.pass();
    else
      counter++;
  }, { autostart: true, restore: false });

  await queue.inited;
  for (let i = 1; i < max; i++) {
    queue.add(i);
  }
  await queue.idle();
  t.is(counter, max);
});

test.serial('should support long async task', async t => {
  const max = 10;
  const time = 50;
  let counter = 1;
  t.timeout(time * max + 2000);

  const queue = new Kiwi(job => {
    t.is(job.data, counter);
    if (job.data === max)
      t.pass();
    else
      return awaitTime(() => counter++, time / 2);
    return null;
  }, { autostart: true, restore: false });

  await queue.inited;
  for (let i = 1; i <= max; i++) {
    queue.add(i);
  }
  await queue.idle();
  t.is(counter, max);
});

test.serial('should restore previous task', async t => {
  await fs.ensureDir('.queue/current');
  await fs.writeJson('.queue/current/a-test-0001.json', { foo: 'bar' });

  const queue = new Kiwi(job => {
    t.deepEqual(job.data, { foo: 'bar' });
    t.pass();
  }, { autostart: true });

  await queue.idle();
});

test.serial('should retry if failed', async t => {
  const max = 2;
  let counter = 0;

  const queue = new Kiwi(job => {
    counter++;
    if (job.data === 1)
      throw 'fail';
  }, { autostart: true, restore: false, retries: 3 });

  await queue.inited;
  for (let i = 1; i <= max; i++) {
    queue.add(i);
  }
  await queue.idle();
  t.is(counter, 5);
  t.pass();
});


async function awaitTime(callback: Function, time: number) {
  return new Promise((resolve) => {
    setTimeout(() => {
      callback();
      resolve();
    }, time);
  });
}