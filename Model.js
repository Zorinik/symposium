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
			return null;

		let message = "Hai a disposizione le seguenti funzioni, per chiamare una funzione scrivi un messaggio che inizia con CALL nome_funzione e a capo inserisci il JSON con gli argomenti, ad esempio:\n" +
			"CALL create_user\n" +
			'{"name":"test"}' + "\n\n" +
			"Lista funzioni:\n";

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
