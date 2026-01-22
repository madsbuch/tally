import { useQuery } from "@tanstack/react-query";
import { db } from "../../../lib/database";
import { useNavigate, useParams } from "../../../router";
import { retryEntryAI } from "../../../lib/ai-processor";
import { useState, useEffect } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { formatBytes } from "../../../lib/format";

function formatDateTime(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function dateToDatetimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export default function SummaryPage() {
  const { id } = useParams("/app/summary/:id");
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  const [editingTimestamp, setEditingTimestamp] = useState(false);
  const [tempTimestamp, setTempTimestamp] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [editingNutrients, setEditingNutrients] = useState(false);
  const [tempCalories, setTempCalories] = useState("");
  const [tempProtein, setTempProtein] = useState("");
  const [tempCarbs, setTempCarbs] = useState("");
  const [tempFat, setTempFat] = useState("");

  const {
    data: entry,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["journal_entry", id],
    queryFn: async () => {
      const entry = await db.journalEntries.get(parseInt(id));
      if (!entry) {
        throw new Error("Entry not found");
      }
      return entry;
    },
    refetchInterval: (query) => {
      // Auto-refresh every 2 seconds while AI is processing
      const entry = query.state.data;
      if (
        entry?.aiProcessingStatus === "pending" ||
        entry?.aiProcessingStatus === "processing"
      ) {
        return 2000;
      }
      return false;
    },
  });

  const handleDeleteClick = () => {
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    try {
      // Delete database entry
      await db.journalEntries.delete(parseInt(id));

      // Go back to where ever the user came from.
      navigate(-1);
    } catch (error) {
      console.error("Error deleting entry:", error);
    }
  };

  // Handle ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showImageModal) {
        handleCloseImageModal();
      }
    };

    if (showImageModal) {
      document.addEventListener("keydown", handleKeyDown);
      // Prevent body scroll when modal is open
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "unset";
    };
  }, [showImageModal]);

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error loading entry</div>;
  }

  if (!entry) {
    return <div>Entry not found</div>;
  }

  // Parse AI response
  const aiResponse = entry.llmResponse
    ? (() => {
        try {
          return JSON.parse(entry.llmResponse);
        } catch {
          return null;
        }
      })()
    : null;

  const handleImageClick = () => {
    if (entry.pictureBlob) {
      setShowImageModal(true);
    }
  };

  const handleDeleteCancel = () => {
    setShowDeleteConfirm(false);
  };

  const handleCloseImageModal = () => {
    setShowImageModal(false);
  };

  const handleRetryAI = async () => {
    setRetrying(true);
    try {
      await retryEntryAI(parseInt(id));
      await refetch();
    } catch (error) {
      console.error("Error retrying AI:", error);
    } finally {
      setRetrying(false);
    }
  };

  const handleEditTimestamp = () => {
    if (entry) {
      setTempTimestamp(dateToDatetimeLocal(entry.insertedAt));
      setEditingTimestamp(true);
    }
  };

  const handleSaveTimestamp = async () => {
    if (!tempTimestamp) return;

    try {
      const newDate = new Date(tempTimestamp);
      await db.journalEntries.update(parseInt(id), {
        insertedAt: newDate,
      });
      setEditingTimestamp(false);
      await refetch();
    } catch (error) {
      console.error("Error updating timestamp:", error);
    }
  };

  const handleCancelTimestamp = () => {
    setEditingTimestamp(false);
    setTempTimestamp("");
  };

  const handleEditNutrients = () => {
    if (entry) {
      setTempCalories(String(Math.abs(entry.energyInKCals)));
      setTempProtein(entry.proteinInGrams ? String(entry.proteinInGrams) : "");
      setTempCarbs(entry.carbsInGrams ? String(entry.carbsInGrams) : "");
      setTempFat(entry.fatInGrams ? String(entry.fatInGrams) : "");
      setEditingNutrients(true);
    }
  };

  const handleSaveNutrients = async () => {
    try {
      const calories = parseFloat(tempCalories) || 0;
      const protein = tempProtein ? parseFloat(tempProtein) : undefined;
      const carbs = tempCarbs ? parseFloat(tempCarbs) : undefined;
      const fat = tempFat ? parseFloat(tempFat) : undefined;

      await db.journalEntries.update(parseInt(id), {
        energyInKCals:
          entryType === "exercise" ? -Math.abs(calories) : Math.abs(calories),
        proteinInGrams: protein,
        carbsInGrams: carbs,
        fatInGrams: fat,
      });
      setEditingNutrients(false);
      await refetch();
    } catch (error) {
      console.error("Error updating nutrients:", error);
    }
  };

  const handleCancelNutrients = () => {
    setEditingNutrients(false);
    setTempCalories("");
    setTempProtein("");
    setTempCarbs("");
    setTempFat("");
  };

  // Determine entry type and properties from your schema
  const entryType =
    entry.type || (entry.energyInKCals >= 0 ? "meal" : "exercise");
  const entryCalories = Math.abs(entry.energyInKCals);
  const entryTitle =
    aiResponse?.description || entry.userText || "Untitled Entry";

  // Check if AI is still processing
  const isAIProcessing =
    entry.aiProcessingStatus === "pending" ||
    entry.aiProcessingStatus === "processing";
  const isAIFailed = entry.aiProcessingStatus === "failed";

  return (
    <div className="py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          {entryType === "meal" ? "Your Meal" : "Your Exercise"}
        </h1>
        <p className="text-gray-600">
          {entryType === "meal"
            ? "Here's what we found in your meal"
            : "Here's your exercise details"}
        </p>

        {/* Timestamp Editor */}
        <div className="mt-2">
          {editingTimestamp ? (
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={tempTimestamp}
                onChange={(e) => setTempTimestamp(e.target.value)}
                className="text-sm px-2 py-1 border border-gray-300 rounded"
              />
              <button
                onClick={handleSaveTimestamp}
                className="text-sm py-1 px-3 rounded font-medium transition-all duration-300"
                style={{
                  backgroundColor: '#2d5f3f',
                  color: '#ffffff'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(45, 95, 63, 0.9)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#2d5f3f';
                }}
              >
                Save
              </button>
              <button
                onClick={handleCancelTimestamp}
                className="text-sm bg-gray-200 hover:bg-gray-300 text-gray-700 py-1 px-3 rounded font-medium"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span>Logged: {formatDateTime(entry.insertedAt)}</span>
              <button
                onClick={handleEditTimestamp}
                className="text-gray-400 hover:text-forest"
                aria-label="Edit timestamp"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                  />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {/* AI Processing Status */}
        {isAIProcessing && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600 mr-3"></div>
              <div>
                <div className="font-medium text-blue-900">
                  Analyzing your entry...
                </div>
                <div className="text-sm text-blue-700">
                  This may take a few seconds
                </div>
              </div>
            </div>
          </div>
        )}

        {/* AI Failed Status */}
        {isAIFailed && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-red-900">
                  AI analysis failed
                </div>
                <div className="text-sm text-red-700">
                  {aiResponse?.error || "Could not analyze entry"}
                </div>
              </div>
              <button
                onClick={handleRetryAI}
                disabled={retrying}
                className="bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {retrying ? "Retrying..." : "Retry"}
              </button>
            </div>
          </div>
        )}

        {/* Image Preview */}
        {entry.pictureBlob ? (
          <div>
            <div
              className="aspect-[4/3] bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:opacity-95 transition-opacity"
              onClick={handleImageClick}
            >
              <img
                src={URL.createObjectURL(entry.pictureBlob)}
                alt={`${entryType} preview`}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="mt-2 text-sm text-gray-500">
              Image size: {formatBytes(entry.pictureBlob.size)}
            </div>
          </div>
        ) : (
          <div
            className={`aspect-[4/3] rounded-lg flex items-center justify-center ${
              entryType === "meal" ? "gradient-meal" : "gradient-exercise"
            }`}
          >
            {entryType === "meal" ? (
              <svg
                className="w-24 h-24 text-forest/60 icon-float"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            ) : (
              <svg
                className="w-24 h-24 text-forest/60 icon-float"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            )}
          </div>
        )}

        {/* Entry Details */}
        <div className="bg-white rounded-lg shadow-sm p-4">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            {entryTitle}
          </h2>

          <div className="grid grid-cols-2 gap-4">
            {/* Left Column: Macros + Calories */}
            <div className="bg-gray-50 p-4 rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-900">Nutrition</h3>
                {!editingNutrients && (
                  <button
                    onClick={handleEditNutrients}
                    className="text-gray-400 hover:text-forest"
                    aria-label="Edit nutrition"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                      />
                    </svg>
                  </button>
                )}
              </div>

              {editingNutrients ? (
                <div className="space-y-3">
                  <div>
                    <label className="text-sm text-gray-600">Calories</label>
                    <input
                      type="number"
                      value={tempCalories}
                      onChange={(e) => setTempCalories(e.target.value)}
                      className="w-full mt-1 px-2 py-1 border border-gray-300 rounded text-sm"
                      placeholder="0"
                    />
                  </div>
                  {entryType === "meal" && (
                    <>
                      <div>
                        <label className="text-sm text-gray-600">
                          Protein (g)
                        </label>
                        <input
                          type="number"
                          value={tempProtein}
                          onChange={(e) => setTempProtein(e.target.value)}
                          className="w-full mt-1 px-2 py-1 border border-gray-300 rounded text-sm"
                          placeholder="0"
                        />
                      </div>
                      <div>
                        <label className="text-sm text-gray-600">
                          Carbs (g)
                        </label>
                        <input
                          type="number"
                          value={tempCarbs}
                          onChange={(e) => setTempCarbs(e.target.value)}
                          className="w-full mt-1 px-2 py-1 border border-gray-300 rounded text-sm"
                          placeholder="0"
                        />
                      </div>
                      <div>
                        <label className="text-sm text-gray-600">Fat (g)</label>
                        <input
                          type="number"
                          value={tempFat}
                          onChange={(e) => setTempFat(e.target.value)}
                          className="w-full mt-1 px-2 py-1 border border-gray-300 rounded text-sm"
                          placeholder="0"
                        />
                      </div>
                    </>
                  )}
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleSaveNutrients}
                      className="flex-1 py-1.5 px-3 rounded text-sm font-medium transition-all duration-300"
                      style={{
                        backgroundColor: '#2d5f3f',
                        color: '#ffffff'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(45, 95, 63, 0.9)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = '#2d5f3f';
                      }}
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelNutrients}
                      className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 py-1.5 px-3 rounded text-sm font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div>
                    <div className="text-3xl font-bold text-gray-900">
                      {entryCalories}
                      <span className="text-sm font-normal text-gray-500 ml-1">
                        {entryType === "exercise" ? "cal burned" : "cal"}
                      </span>
                    </div>
                  </div>
                  {entryType === "meal" && (
                    <div className="space-y-1 pt-2">
                      {entry.proteinInGrams !== undefined && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">Protein</span>
                          <span className="font-medium text-gray-900">
                            {Math.round(entry.proteinInGrams)}g
                          </span>
                        </div>
                      )}
                      {entry.carbsInGrams !== undefined && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">Carbs</span>
                          <span className="font-medium text-gray-900">
                            {Math.round(entry.carbsInGrams)}g
                          </span>
                        </div>
                      )}
                      {entry.fatInGrams !== undefined && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">Fat</span>
                          <span className="font-medium text-gray-900">
                            {Math.round(entry.fatInGrams)}g
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right Column: Text Details */}
            <div className="bg-gray-50 p-4 rounded-lg">
              <h3 className="font-semibold text-gray-900 mb-3">Details</h3>
              <div className="space-y-2">
                {aiResponse?.description && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide">
                      Description
                    </div>
                    <div className="text-sm text-gray-900 mt-1">
                      {aiResponse.description}
                    </div>
                  </div>
                )}
                {entry.userText && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide">
                      Your Notes
                    </div>
                    <div className="text-sm text-gray-900 mt-1">
                      {entry.userText}
                    </div>
                  </div>
                )}
                {aiResponse?.confidence && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide">
                      AI Confidence
                    </div>
                    <div className="text-sm font-medium text-gray-900 mt-1">
                      {Math.round(aiResponse.confidence * 100)}%
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4">
          <button
            onClick={handleDeleteClick}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded-lg font-medium text-center"
          >
            Delete Entry
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title="Delete Entry?"
        message="Are you sure you want to delete this entry? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
      />

      {/* Image Modal */}
      {showImageModal && entry.pictureBlob && (
        <div
          className="fixed inset-0 z-50 bg-black bg-opacity-90 flex items-center justify-center p-4"
          onClick={handleCloseImageModal}
        >
          {/* Close Button */}
          <button
            onClick={handleCloseImageModal}
            className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors z-10"
            aria-label="Close"
          >
            <svg
              className="w-8 h-8"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>

          {/* Image Container */}
          <div
            className="max-w-full max-h-full overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={URL.createObjectURL(entry.pictureBlob)}
              alt={`${entryType} full size`}
              className="max-w-full max-h-[90vh] object-contain"
              style={{
                touchAction: "pinch-zoom",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
