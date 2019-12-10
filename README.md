# kiwi

Queue job that using file system. You don't need redis, just a folder.

Documentation here : https://superdevofficial.github.io/kiwi/

## Features

1. Run async job and preserver order.
2. Retry on fail.
3. Restore queue from filesystem (usefull if the app crash).

## install

```bash
npm install --save @superdevofficial/kiwi
```

## How to use it

Look at [example in documentation api](/kiwi/classes/kiwi.html) or in [main.spec.ts](https://github.com/superdevofficial/kiwi/blob/master/src/lib/main.spec.ts).