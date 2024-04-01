export default class Model {
	type = 'llm';
	name;
	label;
	tokens;
	supports_functions = false;

	constructor() {
		if (!this.label)
			this.label = this.name;
	}

	async generate(thread, payload = {}, functions = []) {
		return null;
	}

	async countTokens(thread) {
		throw new Error('countTokens not implemented in this model');
	}

	promptFromFunctions(payload, functions) {
		if (payload.function_call)
			functions = functions.filter(f => f.name !== payload.function_call);

		if (!functions.length)
			return '';

		let message;
		if (payload.function_call) {
			message = "Nella prossima risposta, rispondi UNICAMENTE seguendo le seguenti istruzioni:\n";
			message += functions[0].description + "\n";
			delete functions[0].description;
			message += "Rispondi con un messaggio che inizia con le parole:\nCALL " + payload.function_call + "\nE poi a capo un oggetto JSON che segue queste direttive OpenAPI:\n";
		} else {
			message = "Hai a disposizione alcune funzioni che puoi chiamare per ottenere risposte o compiere azioni. Ricorda che devi attendere la risposta dalla funzione per sapere se ha avuto successo. Per chiamare una funzione scrivi un messaggio che inizia con CALL nome_funzione e a capo inserisci il JSON con gli argomenti; delimitando il tutto da 3 caratteri ``` - ad esempio:\n" +
				"```\n" +
				"CALL create_user\n" +
				'{"name":"test"}' + "\n" +
				"```\n\n" +
				"Lista delle funzioni che hai a disposizione:\n";

			for (let f of functions)
				message += '- ' + f.name + "\n " + f.description + "\n";
		}

		message += "\nOpenAPI specs:\n\n";
		for (let f of functions) {
			if (!f.parameters)
				continue;
			message += '=== ' + f.name + " ===\n" + JSON.stringify(f.parameters.properties) + "\n\n";
		}

		if (payload.function_call)
			message += "\nNella risposta non deve esserci NIENTE ALTRO se non queste due cose, non saranno prese in considerazione dal sistema altro genere di risposte.";

		return message;
	}
}
