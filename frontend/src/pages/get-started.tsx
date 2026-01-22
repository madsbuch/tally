import { useState, useEffect } from "react";
import { useNavigate } from "../router";
import { db, getConfig } from "../lib/database";
import { getOpenAIService } from "../lib/openai";

// Logo component matching the marketing design
function TallyLogo({ className = "w-32 h-32" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 400"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="400" height="400" rx="80" fill="#2D5F3F" />
      <g transform="translate(200, 200)">
        <rect x="-60" y="-40" width="28" height="80" rx="14" fill="#FFFFFF" />
        <rect x="-14" y="-70" width="28" height="140" rx="14" fill="#FFFFFF" />
        <rect x="32" y="-55" width="28" height="110" rx="14" fill="#FFFFFF" />
      </g>
    </svg>
  );
}

export default function WelcomePage() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Check if already configured
    const checkSetup = async () => {
      try {
        const config = await getConfig();

        if (config?.openAiKey) {
          navigate("/app/journal");
        }
      } catch (err) {
        console.error("Setup check failed:", err);
      } finally {
        setCheckingSetup(false);
      }
    };

    checkSetup();
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Test the API key first
      const openai = getOpenAIService();
      const isValid = await openai.testApiKey(apiKey);

      if (!isValid) {
        throw new Error(
          "Invalid OpenAI API key. Please check your key and try again.",
        );
      }

      // Save the API key
      await db.config.update(1, {
        openAiKey: apiKey,
      });

      navigate("/app/journal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save API key");
    } finally {
      setLoading(false);
    }
  };

  if (checkingSetup) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: "#fdfdf8" }}
      >
        <div className="text-center">
          <div
            className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto"
            style={{ borderColor: "#2d5f3f" }}
          ></div>
          <p className="mt-2" style={{ color: "#2a2a2a" }}>
            Setting up...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background: "linear-gradient(to bottom right, #fdfdf8, #f8f9f5)",
      }}
    >
      <div
        className="max-w-md w-full space-y-8 p-8 bg-white rounded-2xl shadow-lg border"
        style={{ borderColor: "rgba(45, 95, 63, 0.1)" }}
      >
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <TallyLogo className="w-24 h-24 drop-shadow-[0_4px_12px_rgba(45,95,63,0.15)]" />
          </div>
          <h2
            className="font-serif text-4xl font-light"
            style={{ color: "#2d5f3f" }}
          >
            Tally
          </h2>
          <p
            className="mt-2 text-sm"
            style={{ color: "rgba(42, 42, 42, 0.7)" }}
          >
            Track what counts. Food journal & autophagy tracker.
          </p>
        </div>

        <div
          className="rounded-lg p-4 border"
          style={{
            backgroundColor: "rgba(168, 197, 168, 0.2)",
            borderColor: "rgba(168, 197, 168, 0.4)",
          }}
        >
          <h3 className="text-sm font-medium mb-2" style={{ color: "#2d5f3f" }}>
            Beta Code
          </h3>
          <p className="text-sm" style={{ color: "rgba(42, 42, 42, 0.7)" }}>
            Enter your beta code in order to get started with Tally
          </p>
        </div>

        <form className="space-y-6" onSubmit={handleSubmit}>
          {error && (
            <div className="text-red-700 text-sm text-center bg-red-50 border border-red-200 rounded-lg p-3">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="apiKey"
              className="block text-sm font-medium mb-2"
              style={{ color: "#2a2a2a" }}
            >
              Beta Code
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              required
              className="w-full px-4 py-3 border rounded-lg shadow-sm placeholder-gray-400 focus:outline-none transition-all"
              style={{ borderColor: "#d1d5db" }}
              onFocus={(e) => {
                e.target.style.borderColor = "#2d5f3f";
                e.target.style.boxShadow = "0 0 0 2px rgba(45, 95, 63, 0.2)";
              }}
              onBlur={(e) => {
                e.target.style.borderColor = "#d1d5db";
                e.target.style.boxShadow = "none";
              }}
              placeholder="Beta Code"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            disabled={loading || !apiKey.trim()}
            className="w-full py-3 px-4 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 hover:-translate-y-0.5 flex items-center justify-center"
            style={{
              backgroundColor:
                loading || !apiKey.trim() ? "#7a9a84" : "#2d5f3f",
              color: "#ffffff",
              boxShadow: "0 4px 20px rgba(45, 95, 63, 0.3)",
            }}
            onMouseEnter={(e) => {
              if (!loading && apiKey.trim()) {
                e.currentTarget.style.boxShadow =
                  "0 6px 30px rgba(45, 95, 63, 0.4)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow =
                "0 4px 20px rgba(45, 95, 63, 0.3)";
            }}
          >
            {loading ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2"></div>
                Validating...
              </>
            ) : (
              "Save & Continue"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
