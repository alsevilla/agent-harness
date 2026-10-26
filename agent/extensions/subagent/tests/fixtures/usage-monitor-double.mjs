// Monitor double for the usage control suite (usage-control.node.ts): worker lifecycle records only; the extension assigns control.
export const instances = [];
export class WorkerMonitor {
	constructor() {
		this.records = new Map();
		this.store = {
			records: this.records,
			begin: () => {
				const record = { id: `w:${this.records.size + 1}`, state: "running" };
				this.records.set(record.id, record);
				return record;
			},
			started() {},
			event() {},
			finish() {},
			changed() {},
		};
		this.control = undefined;
		instances.push(this);
	}
	compact(text) {
		return text;
	}
}
