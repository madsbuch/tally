import { useState, useEffect } from "react";
import { db, getConfig, getEstimatedQuota } from "../../lib/database";
import { getOpenAIService } from "../../lib/openai";
import { useQuery } from "@tanstack/react-query";
import { formatBytes } from "../../lib/format";

export const OPENAI_MODELS = [
  { value: "gpt-5-2025-08-07", label: "GTP-5" },
  { value: "gpt-4o", label: "GPT-4o (Recommended)" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini (Cheaper)" },
  { value: "gpt-4", label: "GPT-4" },
  { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo (Budget)" },
];

export default function ConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const [formData, setFormData] = useState({
    apiKey: "",
    openai_model: "gpt-5-2025-08-07",
    daily_calorie_budget: 1500,
  });

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const config = await getConfig();

      setFormData({
        apiKey: config.openAiKey || "",
        openai_model: config.openAiModel,
        daily_calorie_budget: config.dailyEnergyInKCalTarget,
      });
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const estimation = useQuery({
    queryKey: ["estimation"],
    queryFn: getEstimatedQuota,
  });

  const handleInputChange = (
    field: keyof typeof formData,
    value: string | number
  ) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));

    // Clear test result when API key changes
    if (field === "apiKey") {
      setTestResult(null);
    }
  };

  const testApiKey = async () => {
    if (!formData.apiKey.trim()) {
      setTestResult({
        success: false,
        message: "Please enter an API key first",
      });
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const openaiService = getOpenAIService();
      const isValid = await openaiService.testApiKey(formData.apiKey.trim());

      if (isValid) {
        setTestResult({ success: true, message: "API key is valid!" });
      } else {
        setTestResult({
          success: false,
          message: "API key is invalid or has insufficient permissions",
        });
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: `Test failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    } finally {
      setTesting(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);

    try {
      await db.config.update(1, {
        openAiKey: formData.apiKey.trim() || undefined,
        openAiModel: formData.openai_model,
        dailyEnergyInKCalTarget: formData.daily_calorie_budget,
      });

      // Reload settings to confirm save
      await loadSettings();

      // Show success message
      setTestResult({ success: true, message: "Settings saved successfully!" });

      // Clear success message after 3 seconds
      setTimeout(() => setTestResult(null), 3000);
    } catch (error) {
      setTestResult({
        success: false,
        message: `Failed to save settings: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-6">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="py-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Configuration</h1>

      <div className="space-y-6">
        {/*  API Key */}
        <div>
          <label
            htmlFor="api-key"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            API Key *
          </label>
          <div className="space-y-2">
            <input
              id="api-key"
              type="password"
              value={formData.apiKey}
              onChange={(e) => handleInputChange("apiKey", e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-forest focus:border-forest"
            />
            <button
              onClick={testApiKey}
              disabled={testing || !formData.apiKey.trim()}
              className="w-full py-2 px-4 rounded-lg font-medium disabled:cursor-not-allowed transition-all duration-300"
              style={{
                backgroundColor: testing || !formData.apiKey.trim() ? '#9ca3af' : '#6b7280',
                color: '#ffffff'
              }}
              onMouseEnter={(e) => {
                if (!testing && formData.apiKey.trim()) {
                  e.currentTarget.style.backgroundColor = '#4b5563';
                }
              }}
              onMouseLeave={(e) => {
                if (!testing && formData.apiKey.trim()) {
                  e.currentTarget.style.backgroundColor = '#6b7280';
                }
              }}
            >
              {testing ? "Testing..." : "Test API Key"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Your API key is stored locally and only used for AI analysis. Get
            one from{" "}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-forest hover:text-forest"
            >
              OpenAI Platform
            </a>
            .
          </p>
        </div>

        {/* Model Selection */}
        <div>
          <label
            htmlFor="model"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            AI Model
          </label>
          <select
            id="model"
            value={formData.openai_model}
            onChange={(e) => handleInputChange("openai_model", e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-forest focus:border-forest"
          >
            {OPENAI_MODELS.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            GPT-4o is recommended for best accuracy. GPT-4o Mini is cheaper but
            less accurate.
          </p>
        </div>

        {/* Daily Calorie Target */}
        <div>
          <label
            htmlFor="calories"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Daily Calorie Target
          </label>
          <input
            id="calories"
            type="number"
            min="800"
            max="5000"
            step="50"
            value={formData.daily_calorie_budget}
            onChange={(e) =>
              handleInputChange(
                "daily_calorie_budget",
                parseInt(e.target.value) || 0
              )
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-forest focus:border-forest"
          />
          <p className="text-xs text-gray-500 mt-1">
            Your daily calorie goal for tracking progress.
          </p>
        </div>

        {/* Test Result */}
        {testResult && (
          <div
            className={`p-4 rounded-lg ${
              testResult.success
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            <p className="text-sm">{testResult.message}</p>
          </div>
        )}

        {/* Save Button */}
        <button
          onClick={saveSettings}
          disabled={saving}
          className="w-full py-2 px-4 rounded-lg font-medium disabled:cursor-not-allowed transition-all duration-300"
          style={{
            backgroundColor: saving ? 'rgba(45, 95, 63, 0.6)' : '#2d5f3f',
            color: '#ffffff'
          }}
          onMouseEnter={(e) => {
            if (!saving) {
              e.currentTarget.style.backgroundColor = 'rgba(45, 95, 63, 0.9)';
            }
          }}
          onMouseLeave={(e) => {
            if (!saving) {
              e.currentTarget.style.backgroundColor = '#2d5f3f';
            }
          }}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>

        {/* Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="text-sm font-medium text-blue-800 mb-2">Notes:</h3>
          <ul className="text-sm text-blue-700 space-y-1 list-disc">
            <li>API key is used for AI meal and exercise analysis</li>
            <li>All data is stored locally in your browser</li>
            <li>Test your API key before saving to ensure it works</li>
          </ul>

          <h3 className="text-sm font-medium text-blue-800 my-2">
            Storage info:
          </h3>
          <ul className="text-sm text-blue-700 space-y-1 list-disc">
            <li>Quota: {formatBytes(estimation.data?.quota)}</li>
            <li>Usage: {formatBytes(estimation.data?.usage)}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
