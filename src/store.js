import fs from 'node:fs';
import path from 'node:path';

// One bot process only. Use a persistent disk so restarts retain panel/ticket IDs.
export class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'state.json');
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { panels: {}, tickets: {} };
    if (!this.data.panels || !this.data.tickets) throw new Error('Invalid state.json; restore a backup before starting.');
  }
  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
