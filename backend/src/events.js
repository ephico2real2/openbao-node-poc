// A small in-memory timeline of credential lifecycle events (secret loaded,
// auth failure, recovery, rotation steps) for the dashboard. Messages are
// written by our own code and never contain secret values.

export function createEventLog(size = 100) {
  const items = [];
  let seq = 0;
  return {
    record(source, type, message, extra = {}) {
      items.push({ id: ++seq, at: new Date().toISOString(), source, type, message, ...extra });
      if (items.length > size) items.shift();
    },
    list(sinceId = 0) {
      return items.filter((e) => e.id > sinceId);
    },
  };
}
