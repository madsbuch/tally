import { useState } from "react";
import { useNavigate } from "../../router";
import { db } from "../../lib/database";
import { processEntryAI } from "../../lib/ai-processor";
import { compressImage } from "../../lib/image-compression";

export default function NewEntryPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<null | string>(null);
  const [loading, setLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [description, setDescription] = useState("");

  const handleFileSelect = async (file: File) => {
    setCompressing(true);
    setError(null);
    try {
      const compressed = await compressImage(file);
      setSelectedImage(compressed);
      setPreviewUrl(URL.createObjectURL(compressed));
    } catch (err) {
      console.error("Image compression failed:", err);
      setError("Failed to compress image. Please try another photo.");
    } finally {
      setCompressing(false);
    }
  };

  const handleSubmit = async () => {
    if (!selectedImage && !description.trim()) {
      setError("Please add a description or photo to continue.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Save entry immediately with pending AI status
      const entryId = await db.journalEntries.add({
        insertedAt: new Date(),
        type: undefined,
        userText: description.trim(),
        llmResponse: "",
        pictureBlob: selectedImage ?? undefined,
        energyInKCals: 0,
        aiProcessingStatus: "pending",
      });

      // Navigate immediately
      navigate("/app/summary/:id", { params: { id: entryId.toString() } });

      // Process AI in background (don't await)
      processEntryAI(entryId).catch((err) => {
        console.error("Background AI processing failed:", err);
      });
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to save entry. Please try again."
      );
      setLoading(false);
    }
  };

  if (loading || compressing) {
    return (
      <div className="py-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">New Entry</h1>
        <div className="text-gray-600">
          {compressing ? "Compressing image..." : "Saving your entry..."}
        </div>
      </div>
    );
  }

  return (
    <div className="py-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Record Progress</h1>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            What did you do?
          </label>
          <textarea
            id="description"
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-forest focus:border-forest text-gray-700 placeholder:text-gray-500"
            placeholder="Examples:
• Had a healthy lunch of grilled chicken salad
• Went for a 30 minute run"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-sm font-medium text-gray-700">
              Add a photo (optional)
            </label>
            {selectedImage && (
              <button
                onClick={() => {
                  setSelectedImage(null);
                  setPreviewUrl(null);
                }}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                Remove photo
              </button>
            )}
          </div>
          {!selectedImage ? (
            <div className="h-64 space-y-4">
              {/* Upload area for meals or activities */}
              <div className="flex flex-col items-center justify-center w-full h-full border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-forest transition">
                <div className="flex flex-col items-center">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    id="captureInput"
                    onChange={(e) =>
                      e.target.files?.[0] && handleFileSelect(e.target.files[0])
                    }
                  />
                  <label
                    htmlFor="captureInput"
                    className="text-gray-500 cursor-pointer hover:text-forest"
                  >
                    📸 Take a photo
                  </label>
                </div>
                <div className="flex flex-col items-center mt-4">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    id="fileInput"
                    onChange={(e) =>
                      e.target.files?.[0] && handleFileSelect(e.target.files[0])
                    }
                  />
                  <label
                    htmlFor="fileInput"
                    className="text-gray-500 cursor-pointer hover:text-forest"
                  >
                    🖼️ Choose from gallery
                  </label>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-48">
              <img
                src={previewUrl!}
                alt="Selected"
                className="w-full h-full object-contain rounded-lg"
              />
            </div>
          )}
        </div>

        <button
          onClick={handleSubmit}
          className="w-full py-2 px-4 rounded-lg font-medium transition-all duration-300"
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
          Add Entry
        </button>
      </div>

      {error && <div className="text-red-500 mt-4">{error}</div>}
    </div>
  );
}
