// tslint:disable:no-expression-statement
import test from 'ava';
import { Kiwi } from './main';

test('should run one task', async t => {
  const queue = new Kiwi(job => {
    t.is(job.data, 'foo');
    t.truthy(job.filename);
    t.pass();
  });
  queue.clear();
  queue.add('foo');
  queue.start();
});
