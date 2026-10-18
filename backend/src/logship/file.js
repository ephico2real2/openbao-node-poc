// Append each (redacted) JSON log line to a file, for a log agent to ship
// (on EC2: the CloudWatch agent tails /var/log/secure-notes/app.jsonl).
// Like every sink, it gets exactly the line stdout gets, never a revealed one.
//
// Writes are synchronous on purpose: the line that explains an exit
// (config.unsafe, secrets.load.fatal) must be on disk before process.exit(),
// or the alarm that reads this file can never fire. A JSON line is small and
// the file is local, so the cost is a few microseconds per line.
// Rotation: logrotate with copytruncate; the descriptor is opened with O_APPEND.
import { openSync, writeSync } from 'node:fs';

export function createFileSink(path) {
  let fd;
  let errors = 0;
  let lastError;
  const open = () => {
    // The file's mode is 0640 before the umask; systemd's UMask decides the rest.
    fd = openSync(path, 'a', 0o640);
  };
  try {
    open();
  } catch (err) {
    errors++;
    lastError = err.code ?? err.message;
  }
  return {
    write(line) {
      try {
        if (fd === undefined) open();
        writeSync(fd, `${line}\n`);
      } catch (err) {
        // Never log through the logger from here (it would loop); the count is
        // reported by stats() in /api/config and the security posture.
        errors++;
        lastError = err.code ?? err.message;
      }
    },
    drain: () => Promise.resolve(),
    stats: () => ({ path, errors, lastError }),
  };
}
