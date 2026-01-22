import { getConfig } from "./database";
import { mkProxiedFetch } from "./proxy";

export interface OpenAIResponse {
  type?: "meal" | "exercise";
  calories?: number;
  description?: string;
  macros?: {
    protein?: number;
    carbs?: number;
    fat?: number;
  };
  confidence?: number;
  error?: string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<{
        type: "text" | "image_url";
        text?: string;
        image_url?: {
          url: string;
          detail: "low" | "high";
        };
      }>;
}

interface OpenAIApiResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

class OpenAIService {
  private async getApiKey(): Promise<string> {
    const settings = await getConfig();

    if (!settings.openAiKey) {
      throw new Error(
        "OpenAI API key not configured. Please add your API key in settings."
      );
    }

    return settings.openAiKey;
  }

  private async makeRequest(
    messages: OpenAIMessage[],
    model?: string
  ): Promise<OpenAIApiResponse> {
    const apiKey = await this.getApiKey();

    // If no model specified, get from database settings
    if (!model) {
      const settings = await getConfig();
      model = settings?.openAiModel;
    }

    // This is a PWA, so we can't access the openAI API directly
    const response = await mkProxiedFetch(apiKey)(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: model !== "gpt-5-2025-08-07" ? 500 : undefined,
          max_completion_tokens:
            model === "gpt-5-2025-08-07" ? 5000 : undefined,
          temperature: model !== "gpt-5-2025-08-07" ? 0.1 : undefined,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `OpenAI API error: ${response.status} - ${
          errorData.error?.message || "Unknown error"
        }`
      );
    }

    return response.json() as Promise<OpenAIApiResponse>;
  }

  private imageToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix to get just base64
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async analyzeMealPhoto(
    imageFile: File,
    userDescription?: string
  ): Promise<OpenAIResponse> {
    try {
      const base64Image = await this.imageToBase64(imageFile);

      const systemPrompt = `You are a nutrition expert. Analyze the food image and provide calorie and macro estimates. 
      
      Respond in JSON format:
      {
        "calories": <number>,
        "description": "<brief description of the food>",
        "macros": {
          "protein": <grams>,
          "carbs": <grams>, 
          "fat": <grams>
        },
        "confidence": <0-1 confidence score>
      }
      
      If you cannot identify the food or make a reasonable estimate, return:
      {
        "error": "Unable to analyze this image"
      }`;

      const userPrompt = userDescription
        ? `Analyze this food image. User description: "${userDescription}"`
        : "Analyze this food image and estimate calories and macros.";

      const messages: OpenAIMessage[] = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "low",
              },
            },
          ],
        },
      ];

      const response = await this.makeRequest(messages);
      const content = response.choices[0]?.message?.content;

      if (!content) {
        return { error: "No response from OpenAI" };
      }

      try {
        // First try to parse as direct JSON
        const parsed = JSON.parse(content);
        return parsed;
      } catch {
        // Try to extract JSON from markdown code fences
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            return parsed;
          } catch {
            return {
              description: content,
              error: "Could not parse JSON from markdown response",
            };
          }
        }

        // If not valid JSON or markdown, return error with content
        return {
          description: content,
          error: "Could not parse structured response",
        };
      }
    } catch (error) {
      console.error("OpenAI meal analysis error:", error);
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  async analyzeExerciseScreenshot(
    imageFile: File,
    userDescription?: string
  ): Promise<OpenAIResponse> {
    try {
      const base64Image = await this.imageToBase64(imageFile);

      const systemPrompt = `You are a fitness expert. Analyze the exercise/fitness screenshot and estimate calories burned.
      
      This could be from fitness apps like Garmin Connect, Strava, Apple Fitness, etc.
      
      Respond in JSON format:
      {
        "calories": <number of calories burned>,
        "description": "<brief description of the exercise>",
        "confidence": <0-1 confidence score>
      }
      
      If you cannot identify the exercise data or make a reasonable estimate, return:
      {
        "error": "Unable to analyze this exercise data"
      }`;

      const userPrompt = userDescription
        ? `Analyze this exercise screenshot. User description: "${userDescription}"`
        : "Analyze this exercise screenshot and estimate calories burned.";

      const messages: OpenAIMessage[] = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "low",
              },
            },
          ],
        },
      ];

      const response = await this.makeRequest(messages);
      const content = response.choices[0]?.message?.content;

      if (!content) {
        return { error: "No response from OpenAI" };
      }

      try {
        // First try to parse as direct JSON
        const parsed = JSON.parse(content);
        return parsed;
      } catch {
        // Try to extract JSON from markdown code fences
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            return parsed;
          } catch {
            return {
              description: content,
              error: "Could not parse JSON from markdown response",
            };
          }
        }

        // If not valid JSON or markdown, return error with content
        return {
          description: content,
          error: "Could not parse structured response",
        };
      }
    } catch (error) {
      console.error("OpenAI exercise analysis error:", error);
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  async testApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await mkProxiedFetch(apiKey)(
        "https://api.openai.com/v1/models"
      );

      return response.ok;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  // Auto-detect entry type and analyze (unified method)
  async analyzeEntry(
    imageFile?: File,
    userDescription?: string
  ): Promise<OpenAIResponse> {
    try {
      const systemPrompt = `You are a nutrition and fitness expert. Analyze the provided content (image and/or text) to determine if the user is logging:
1. FOOD/MEAL - calories consumed (intake)
2. EXERCISE/ACTIVITY - calories burned

Respond in JSON format:
{
  "type": "meal" or "exercise",
  "calories": <number>,
  "description": "<brief description>",
  "macros": {
    "protein": <grams>,
    "carbs": <grams>,
    "fat": <grams>
  },
  "confidence": <0-1 confidence score>
}

Notes:
- Only include "macros" for meals, not for exercise
- For exercise, calories represents calories BURNED
- For meals, calories represents calories CONSUMED
- Be specific in the description
- Low confidence for complex composite meals

If you cannot determine the type or make a reasonable estimate, return:
{
  "error": "Unable to analyze this entry"
}`;

      let userPrompt =
        "Analyze this entry and determine if it's a meal or exercise.";
      if (userDescription) {
        userPrompt = `Analyze this entry. User description: "${userDescription}"`;
      }

      const messages: OpenAIMessage[] = [
        { role: "system", content: systemPrompt },
      ];

      if (imageFile) {
        const base64Image = await this.imageToBase64(imageFile);
        messages.push({
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "low",
              },
            },
          ],
        });
      } else if (userDescription) {
        messages.push({
          role: "user",
          content: userPrompt,
        });
      } else {
        return { error: "No image or description provided" };
      }

      const response = await this.makeRequest(messages);
      const content = response.choices[0]?.message?.content;

      if (!content) {
        return { error: "No response from OpenAI" };
      }

      try {
        // First try to parse as direct JSON
        const parsed = JSON.parse(content);
        return parsed;
      } catch {
        // Try to extract JSON from markdown code fences
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            return parsed;
          } catch {
            return {
              description: content,
              error: "Could not parse JSON from markdown response",
            };
          }
        }

        // If not valid JSON or markdown, return error with content
        return {
          description: content,
          error: "Could not parse structured response",
        };
      }
    } catch (error) {
      console.error("OpenAI entry analysis error:", error);
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  // Analyze text-only entries (when no image is provided)
  async analyzeTextEntry(
    description: string,
    type: "meal" | "exercise"
  ): Promise<OpenAIResponse> {
    try {
      const systemPrompt =
        type === "meal"
          ? `You are a nutrition expert. Based on the text description of food, estimate calories and macros.
          
          Respond in JSON format:
          {
            "calories": <number>,
            "description": "<interpreted food description>",
            "macros": {
              "protein": <grams>,
              "carbs": <grams>,
              "fat": <grams>
            },
            "confidence": <0-1 confidence score>
          }`
          : `You are a fitness expert. Based on the text description of exercise, estimate calories burned.
          
          Respond in JSON format:
          {
            "calories": <number of calories burned>,
            "description": "<interpreted exercise description>",
            "confidence": <0-1 confidence score>
          }`;

      const messages: OpenAIMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Analyze this ${type}: "${description}"` },
      ];

      const response = await this.makeRequest(messages);
      const content = response.choices[0]?.message?.content;

      if (!content) {
        return { error: "No response from OpenAI" };
      }

      try {
        // First try to parse as direct JSON
        const parsed = JSON.parse(content);
        return parsed;
      } catch {
        // Try to extract JSON from markdown code fences
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            return parsed;
          } catch {
            return {
              description: content,
              error: "Could not parse JSON from markdown response",
            };
          }
        }

        // If not valid JSON or markdown, return error with content
        return {
          description: content,
          error: "Could not parse structured response",
        };
      }
    } catch (error) {
      console.error("OpenAI text analysis error:", error);
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }
}

// Singleton instance
let openaiServiceInstance: OpenAIService | null = null;

export function getOpenAIService(): OpenAIService {
  if (!openaiServiceInstance) {
    openaiServiceInstance = new OpenAIService();
  }
  return openaiServiceInstance;
}
