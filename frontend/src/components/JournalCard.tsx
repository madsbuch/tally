import { JournalEntry } from "../lib/database";

interface MealCardProps {
  entry: JournalEntry;
}

export default function JournalCard({ entry }: MealCardProps) {
  const aiResponse = entry.llmResponse
    ? (() => {
        try {
          return JSON.parse(entry.llmResponse);
        } catch {
          return null;
        }
      })()
    : null;
  const entryTitle =
    aiResponse?.description || entry.userText || "Untitled Entry";
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden mb-4">
      {entry.pictureBlob && (
        <div className="aspect-[4/3] relative">
          <img
            src={URL.createObjectURL(entry.pictureBlob)}
            alt={entry.userText || "Journal entry"}
            className="w-full h-full object-cover"
          />
          <div className="absolute top-4 right-4 bg-white/90 backdrop-blur-sm rounded-full px-3 py-1 text-sm font-medium">
            {new Date(entry.insertedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </div>
        </div>
      )}

      <div className="p-4">
        <div className="flex justify-between items-start mb-2">
          <div>
            <h3 className="font-medium text-gray-900">{entryTitle}</h3>
            {!entry.pictureBlob && (
              <div className="text-sm text-gray-500">
                {new Date(entry.insertedAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
            )}
            {entry.userText && (
              <p className="text-sm text-gray-600 mt-1">{entry.userText}</p>
            )}
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {Math.abs(entry.energyInKCals)}
            <span className="text-sm font-normal text-gray-500 ml-1">
              {entry.energyInKCals < 0 ? "cal burned" : "cal"}
            </span>
          </div>
        </div>

        <div className="flex gap-4 text-sm text-gray-600">
          <div>
            <span className="font-medium capitalize">
              {entry.energyInKCals < 0 ? "exercise" : "meal"}
            </span>
          </div>
          {entry.energyInKCals >= 0 && (
            <>
              {entry.fatInGrams && (
                <div>
                  <span className="font-medium">
                    {Math.round(entry.fatInGrams)}g
                  </span>{" "}
                  Fat
                </div>
              )}
              {entry.carbsInGrams && (
                <div>
                  <span className="font-medium">
                    {Math.round(entry.carbsInGrams)}g
                  </span>{" "}
                  Carbs
                </div>
              )}
              {entry.proteinInGrams && (
                <div>
                  <span className="font-medium">
                    {Math.round(entry.proteinInGrams)}g
                  </span>{" "}
                  Protein
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
