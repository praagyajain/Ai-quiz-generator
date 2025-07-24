import { GoogleGenerativeAI } from "@google/generative-ai";

export type OutputFormat = {
  [key: string]: string | string[];
};

export async function strict_output(
  system_prompt: string,
  user_prompt: string | string[],
  output_format: OutputFormat,
  default_category: string = "",
  output_value_only: boolean = false,
  model: string = "models/gemini-1.5-flash",
  temperature: number = 0.7,
  num_tries: number = 3,
  verbose: boolean = false
): Promise<
  {
    question: string;
    answer: string;
  }[]
> {
  const list_input = Array.isArray(user_prompt);
  const dynamic_elements = /<.*?>/.test(JSON.stringify(output_format));
  const list_output = /\[.*?\]/.test(JSON.stringify(output_format));

  let error_msg = "";

  for (let i = 0; i < num_tries; i++) {
    let format_instructions = `\n\nONLY return a valid JSON object following this shape: ${JSON.stringify(
      output_format
    )}.\nDo not wrap the JSON inside code blocks.\nDo not use single quotes.\nAvoid trailing commas.\nReturn ONLY raw valid JSON with NO explanations, NO markdown, and NO comments.\n`;

    if (list_input) {
      format_instructions += `\nReturn an array of JSON objects – one for each user input.`;
    }

    if (dynamic_elements) {
      format_instructions += `\nAny key or value wrapped in <...> must be replaced dynamically with contextually accurate content.`;
    }

    format_instructions += `\n\n⚠️ Output MUST be directly parsable by JavaScript's JSON.parse() – no explanation, no markdown formatting, no extra comments.`;

    const prompt = `${system_prompt}${format_instructions}${error_msg}\n\nINPUT:\n${Array.isArray(user_prompt) ? user_prompt.join("\n") : user_prompt}`;

    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
      const geminiModel = genAI.getGenerativeModel({ model });

      const result = await geminiModel.generateContent(prompt);
      let res = (await result.response.text()).trim();

      if (verbose) {
        console.log("==== RAW OUTPUT FROM GEMINI ====");
        console.log(res);
      }

      // Clean up
      res = res.replace(/```json|```/g, "").trim(); // remove code block tags
      res = res.replace(/'/g, '"'); // single to double quotes
      res = res.replace(/,\s*([}\]])/g, "$1"); // remove trailing commas

      // Extract JSON block
      let jsonMatch = res.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error("No valid JSON object found.");
      }

      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (jsonErr) {
        if (jsonErr instanceof Error) {
          console.error("❌ JSON.parse failed:", jsonErr.message);
        } else {
          console.error("❌ JSON.parse failed:", jsonErr);
        }
        console.error("🔍 JSON content was:", jsonMatch[0]);
        throw jsonErr;
      }

      const outputs = Array.isArray(parsed) ? parsed : [parsed];

      // Sanitize and validate
      for (let item of outputs) {
        for (const key in output_format) {
          if (!(key in item)) {
            if (!key.includes("<")) {
              throw new Error(`Missing key '${key}' in item: ${JSON.stringify(item)}`);
            }
            continue;
          }

          if (Array.isArray(output_format[key])) {
            const options = output_format[key] as string[];

            if (Array.isArray(item[key])) item[key] = item[key][0];
            if (!options.includes(item[key]) && default_category) {
              item[key] = default_category;
            }
          }
        }

        if (output_value_only) {
          const values = Object.values(item);
          item = values.length === 1 ? values[0] : values;
        }
      }

      return outputs;
    } catch (e: any) {
      if (verbose) {
        console.warn(`❌ Attempt ${i + 1} failed with model [${model}]:`, e.message);
      }
      error_msg = `\n\n[PREVIOUS ATTEMPT FAILED: ${e.message}]`;
    }
  }

  throw new Error("All attempts failed to produce valid structured output.");
}
