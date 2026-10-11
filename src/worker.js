async function processOne() {
  return false;
}

async function run() {
  console.log('Recovery SMS worker is disabled. Calls are handled by the voice agent.');
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Voice service startup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { processOne, run };
