import Message from "./Message.js";

export default class Model {
	type = 'llm';
	name;
	name_for_tiktoken;
	label;
	tokens;
	supports_functions = false;

	constructor() {
		if (!this.label)
			this.label = this.name;
		if (!this.name_for_tiktoken)
			this.name_for_tiktoken = this.name;
	}

	async generate(thread, payload = {}, functions = []) {
		return null;
	}

	promptFromFunctions(functions) {
		if (!functions.length)
			return '';

		let message = "Hai a disposizione alcune funzioni che puoi chiamare per ottenere risposte o compiere azioni. Ricorda che devi attendere la risposta dalla funzione per sapere se ha avuto successo. Per chiamare una funzione scrivi un messaggio che inizia con CALL nome_funzione e a capo inserisci il JSON con gli argomenti; delimitando il tutto da 3 caratteri ``` - ad esempio:\n" +
			"```\n" +
			"CALL create_user\n" +
			'{"name":"test"}' + "\n" +
			"```\n\n" +
			"Lista delle funzioni che hai a disposizione:\n";

		for (let f of functions)
			message += '- ' + f.name + "\n " + f.description + "\n";

		message += "\nOpenAPI specs:\n\n";
		for (let f of functions) {
			if (!f.parameters)
				continue;
			message += '=== ' + f.name + " ===\n" + JSON.stringify(f.parameters.properties) + "\n\n";
		}

		return message;
	}
}
