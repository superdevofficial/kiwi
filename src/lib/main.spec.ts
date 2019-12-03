// tslint:disable:no-expression-statement
import test from 'ava';
import { Kiwi } from './main';

test('should run one task', async t => {
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
