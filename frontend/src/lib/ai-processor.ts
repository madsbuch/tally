import { db } from "./database";
import { getOpenAIService, OpenAIResponse } from "./openai";

/**
 * Process pending AI jobs for journal entries
 */
export async function processPendingAIJobs(): Promise<void> {
  const pendingEntries = await db.journalEntries
    .filter((entry) => entry.aiProcessingStatus === "pending")
    .toArray();

  for (const entry of pendingEntries) {
    await processEntryAI(entry.id);
  }
}

/**
 * Process AI analysis for a specific entry
 */
export async function processEntryAI(entryId: number): Promise<void> {
  const entry = await db.journalEntries.get(entryId);
  if (!entry) {
    return;
  }

  // Mark as processing
  await db.journalEntries.update(entryId, {
    aiProcessingStatus: "processing",
  });

  try {
    const openai = getOpenAIService();

    // Convert Blob to File if present
    let imageFile: File | undefined = undefined;
    if (entry.pictureBlob) {
      imageFile = new File([entry.pictureBlob], "entry-image.jpg", {
        type: entry.pictureBlob.type || "image/jpeg",
      });
    }

    // Use auto-detection to analyze entry
    const aiResponse: OpenAIResponse = await openai.analyzeEntry(
      imageFile,
      entry.userText.trim() || undefined
    );

    if (aiResponse.error) {
      // Mark as failed
      await db.journalEntries.update(entryId, {
        aiProcessingStatus: "failed",
        llmResponse: JSON.stringify(aiResponse),
      });
      return;
    }

    // Determine type from AI response, fallback to meal if not specified
    const entryType = aiResponse.type || "meal";

    // Determine energy value (positive for meals, negative for exercise)
    const energyValue = aiResponse.calories || 0;
    const energyInKCals =
      entryType === "exercise" ? -Math.abs(energyValue) : Math.abs(energyValue);

    // Update entry with AI results
    await db.journalEntries.update(entryId, {
      type: entryType,
      llmResponse: JSON.stringify(aiResponse),
      energyInKCals: energyInKCals,
      proteinInGrams: aiResponse.macros?.protein,
      carbsInGrams: aiResponse.macros?.carbs,
      fatInGrams: aiResponse.macros?.fat,
      aiProcessingStatus: "completed",
    });
  } catch (error) {
    console.error("AI processing error:", error);
    // Mark as failed
    await db.journalEntries.update(entryId, {
      aiProcessingStatus: "failed",
      llmResponse: JSON.stringify({
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      }),
    });
  }
}

/**
 * Retry AI processing for a failed entry
 */
export async function retryEntryAI(entryId: number): Promise<void> {
  await db.journalEntries.update(entryId, {
    aiProcessingStatus: "pending",
  });
  await processEntryAI(entryId);
}
