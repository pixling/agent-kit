#!/usr/bin/env node
// A stand-in for `afplay`: appends what it was given to play to $FAKE_PLAYED (one JSON
// line: the file's contents as text) and its pid to $FAKE_PLAYED.pids, then takes
// $FAKE_PLAY_MS to "play" it.
import fs from 'node:fs';

fs.appendFileSync(process.env.FAKE_PLAYED, JSON.stringify(fs.readFileSync(process.argv[2], 'utf8')) + '\n');
fs.appendFileSync(`${process.env.FAKE_PLAYED}.pids`, `${process.pid}\n`);
setTimeout(() => {}, Number(process.env.FAKE_PLAY_MS ?? 0));
