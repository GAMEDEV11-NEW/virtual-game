// ============================================================================
// Process items in parallel with concurrency limit
// ============================================================================
async function processInParallel(items, processor, concurrency = 5) {
  if (!items || items.length === 0) {
    return [];
  }

  const results = [];
  const executing = [];

  for (const item of items) {
    const promise = Promise.resolve(processor(item)).then(
      result => {
        executing.splice(executing.indexOf(promise), 1);
        return result;
      },
      error => {
        executing.splice(executing.indexOf(promise), 1);
        return { error: error.message, item };
      }
    );

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

module.exports = {
  processInParallel
};
