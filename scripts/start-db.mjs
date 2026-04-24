import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';

const DOCKER_DESKTOP_WIN = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;

function dockerEngineReady() {
  const res = spawnSync('docker', ['info'], { stdio: 'ignore', shell: true });
  return res.status === 0;
}

function launchDockerDesktop() {
  if (process.platform === 'win32') {
    if (!existsSync(DOCKER_DESKTOP_WIN)) {
      throw new Error(`Docker Desktop não encontrado em ${DOCKER_DESKTOP_WIN}`);
    }
    spawn(DOCKER_DESKTOP_WIN, [], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
    return;
  }
  throw new Error(`Inicialização automática do Docker não suportada em ${process.platform}. Suba o Docker manualmente.`);
}

async function waitForEngine() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  process.stdout.write('Aguardando Docker engine');
  while (Date.now() < deadline) {
    if (dockerEngineReady()) {
      process.stdout.write(' pronto.\n');
      return true;
    }
    process.stdout.write('.');
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write('\n');
  return false;
}

async function main() {
  if (!dockerEngineReady()) {
    console.log('Docker não está rodando. Iniciando Docker Desktop...');
    launchDockerDesktop();
    const ready = await waitForEngine();
    if (!ready) {
      console.error(`Timeout (${READY_TIMEOUT_MS / 1000}s) aguardando o Docker ficar pronto.`);
      process.exit(1);
    }
  }

  const up = spawnSync('docker', ['compose', 'up', '-d', '--wait', 'db'], {
    stdio: 'inherit',
    shell: true,
  });
  process.exit(up.status ?? 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
