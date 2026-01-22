import Dexie, { EntityTable } from "dexie";

/**
 * We use this merely to persist config.
 * We only expect a single row to be in the database
 * there is no need for any indices in the table
 *
 * Please use `getConfig` to interact with the config
 */
export type Config = {
  /**
   * Needed, we only use id = 1
   */
  id: number;

  openAiKey?: string;
  openAiModel: string;

  dailyEnergyInKCalTarget: number;
};

export type JournalEntry = {
  // ##### Indexable fields

  id: number;
  insertedAt: Date;

  // ##### Other fields

  /**
   * Type of entry: meal or exercise
   */
  type?: "meal" | "exercise";

  /**
   * Text entered by the user in the UI
   */
  userText: string;
  llmResponse: string;
  pictureBlob?: Blob;

  /**
   * AI processing status for offline support
   */
  aiProcessingStatus?: "pending" | "processing" | "completed" | "failed";

  /**
   * kCals for the food / activity.
   *
   * positive means consumes calories
   * negative means used calories (activities)
   */
  energyInKCals: number;

  /**
   * Amount of protein
   *
   * only applicable when food
   */
  proteinInGrams?: number;

  /**
   * Amount of carbon hydrates
   *
   * only applicable when food
   */
  carbsInGrams?: number;

  /**
   * Amount of fats
   *
   * only applicable when food
   */
  fatInGrams?: number;
};

// Bah - lorte typer
export const db = new Dexie("CalorieJournal") as Dexie & {
  journalEntries: EntityTable<
    JournalEntry,
    // primary key "id" (for the typings only)
    "id"
  >;
  config: EntityTable<Config, "id">;
};

// Schema declaration:
db.version(1).stores({
  // primary key "id" (for the runtime!)
  journalEntries: "++id, insertedAt",
  config: "++id",
});

export const getConfig = async (): Promise<Config> => {
  const c = await db.config.get(1);

  if (c) {
    return c;
  }

  const defaultC: Config = {
    id: 1,
    dailyEnergyInKCalTarget: 2000,
    openAiModel: "gpt-4o",
  };

  await db.config.add(defaultC);
  return defaultC;
};

export const getEstimatedQuota = async () => {
  await navigator.storage.persist();
  if (navigator.storage && navigator.storage.estimate) {
    return await navigator.storage.estimate();
  }
};

async function showEstimatedQuota() {
  if (navigator.storage && navigator.storage.estimate) {
    const estimation = await navigator.storage.estimate();
    console.log(`Quota: ${estimation.quota}`);
    console.log(`Usage: ${estimation.usage}`);
    return estimation;
  } else {
    console.error("StorageManager not found");
  }
}
showEstimatedQuota();
