import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class StartupTest(unittest.TestCase):
    def run_script(self, fail_seed=False, fail_up=False):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            docker = folder / 'docker'
            docker.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$STARTUP_LOG"
if [[ "$*" == *"seed:elastic"* && "$FAIL_SEED" == 1 ]]; then exit 1; fi
if [[ "$*" == *"compose up"* && "$FAIL_UP" == 1 ]]; then exit 1; fi
exit 0
''')
            docker.chmod(0o755)
            # Impede que o script antigo encerre processos durante este teste.
            for name in ['fuser', 'lsof']:
                script = folder / name
                script.write_text('#!/bin/bash\nexit 0\n')
                script.chmod(0o755)
            log = folder / 'commands'
            env = dict(os.environ, PATH=f'{folder}:{os.environ["PATH"]}', STARTUP_LOG=str(log), FAIL_SEED=str(int(fail_seed)), FAIL_UP=str(int(fail_up)))
            result = subprocess.run(['bash', str(ROOT / 'iniciar.sh')], env=env, capture_output=True, text=True, timeout=15)
            return result, log.read_text()

    def test_waits_and_indexes_before_success(self):
        result, commands = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--wait', commands)
        self.assertIn('compose exec -T app npm run seed:elastic', commands)
        self.assertLess(commands.index('compose up'), commands.index('seed:elastic'))

    def test_comment_only_redis_file_is_not_executed(self):
        result, commands = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('redis-cli', commands)

    def test_seed_failure_does_not_report_ready(self):
        result, _ = self.run_script(fail_seed=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('ATIVO E PRONTO', result.stdout)

    def test_startup_failure_does_not_run_seed(self):
        result, commands = self.run_script(fail_up=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('seed:elastic', commands)
        self.assertNotIn('ATIVO E PRONTO', result.stdout)

if __name__ == '__main__':
    unittest.main()
