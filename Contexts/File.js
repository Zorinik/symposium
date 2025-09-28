import fs from "fs";
import Context from "../Context.js";

export default class File extends Context {
	constructor(file) {
		super();
		this.file = file;
	}

	async getText() {
		if (this.file.startsWith('http://') || this.file.startsWith('https://')) {
			return fetch(this.file);
		} else {
			if (fs.existsSync(this.file))
				return fs.promises.readFile(this.file, "utf8");
			else
				throw new Error(`File not found: ${this.file}`);
		}
	}
}
