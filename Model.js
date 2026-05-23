export default class Model {
	type = 'llm';
	tokens;
	system_role_name = 'system';

	async getModels() {
		return new Map();
	}

	async *generate(model, thread, tools = [], options = {}) {
		// Subclasses implement as async generator: yield deltas during streaming,
		// return assembled Message[] when complete.
		// Delta shape:
		//   {type: 'text_delta',      content: string}
		//   {type: 'reasoning_delta', content: string}
		//   {type: 'tool_call',       content: {id?, name, arguments}}
		//   {type: 'image',           content: <image-block-content>, meta}
		return null;
	}

	async countTokens(thread) {
		throw new Error('countTokens not implemented in this model');
	}

	parseOptions(options = {}, tools = []) {
		options = {
			tools: null,
			force_tool: null,
			...options,
		};

		if (options.tools !== null)
			tools = options.tools;

		if (options.force_tool && !tools.find(t => t.name === options.force_tool))
			throw new Error('Tool ' + options.force_tool + ' not found.');

		return {options, tools};
	}

	promptFromTools(options, tools) {
		if (options.force_tool)
			tools = tools.filter(t => t.name !== options.force_tool);

		if (!tools.length)
			return '';

		let message;
		if (options.force_tool) {
			message = "Nella prossima risposta, rispondi UNICAMENTE seguendo le seguenti istruzioni:\n";
			message += tools[0].description + "\n";
			delete tools[0].description;
			message += "Rispondi con un messaggio che inizia con le parole:\nCALL " + options.force_tool + "\nE poi a capo un oggetto JSON che segue queste direttive OpenAPI:\n";
		} else {
			message = "Hai a disposizione alcuni strumenti che puoi chiamare per ottenere risposte o compiere azioni. Ricorda che devi attendere la risposta dello strumento per sapere se ha avuto successo. Per chiamare uno strumento scrivi un messaggio che inizia con CALL nome_strumento e a capo inserisci il JSON con gli argomenti; delimitando il tutto da 3 caratteri ``` - ad esempio:\n" +
				"```\n" +
				"CALL create_user\n" +
				'{"name":"test"}' + "\n" +
				"```\n\n" +
				"Lista degli strumenti che hai a disposizione:\n";

			for (let t of tools)
				message += '- ' + t.name + "\n " + t.description + "\n";
		}

		message += "\nOpenAPI specs:\n\n";
		for (let t of tools) {
			if (!t.parameters)
				continue;
			message += '=== ' + t.name + " ===\n" + JSON.stringify(t.parameters.properties) + "\n\n";
		}

		if (options.force_tool)
			message += "\nNella risposta non deve esserci NIENTE ALTRO se non queste due cose, non saranno prese in considerazione dal sistema altro genere di risposte.";

		return message;
	}
}
