# kiwi

Queue job that using file system. You don't need redis, just a folder.

## Features

1. Run async job and preserver order.
2. Retry on fail.
3. Restore queue from filesystem (usefull if the app crash).

## install

```bash
npm install --save @superdevofficial/kiwi
```

## How to use it

Look at [example in documentation api](/docs/classes/kiwi.html) or in [main.spec.ts](/src/main.spec.ts).