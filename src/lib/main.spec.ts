// tslint:disable:no-expression-statement
import test from 'ava';
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
  const max = 4;
  let counter = 0;
  const queue = new Kiwi(job => {
    t.is(job.data, counter);
    if (job.data === max)
      t.pass();
    else
      counter++;
  });
  await queue.clear();
  for (let i = 0; i <= max; i++) {
    queue.add(i);
  }
  queue.start();
  await queue.idle();
  t.is(counter, max);
});

test.serial('should auto start', async t => {
  const max = 4;
  let counter = 0;
  const queue = new Kiwi(job => {
    t.is(job.data, counter);
    if (job.data === max)
      t.pass();
    else
      counter++;
  }, { autostart: true, restore: false });
  for (let i = 0; i <= max; i++) {
    queue.add(i);
  }
  await queue.idle();
  t.is(counter, max);
});
