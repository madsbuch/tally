import { useState, useEffect } from "react";
import { useNavigate } from "../router";
import { getConfig } from "../lib/database";

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

export default function MarketingPage() {
  const [checkingSetup, setCheckingSetup] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Enable scrolling for marketing page
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
    document.documentElement.style.height = "auto";
    document.body.style.height = "auto";

    return () => {
      // Restore default overflow behavior when leaving
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      document.documentElement.style.height = "";
      document.body.style.height = "";
    };
  }, []);

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

  useEffect(() => {
    // Scroll reveal animation
    function reveal() {
      const reveals = document.querySelectorAll(".reveal");

      reveals.forEach((element) => {
        const windowHeight = window.innerHeight;
        const elementTop = element.getBoundingClientRect().top;
        const elementVisible = 150;

        if (elementTop < windowHeight - elementVisible) {
          element.classList.add("active");
        }
      });
    }

    window.addEventListener("scroll", reveal);
    reveal(); // Check on load

    return () => window.removeEventListener("scroll", reveal);
  }, []);

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
            Loading...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: "#fdfdf8", color: "#2a2a2a" }}
    >
      {/* Hero Section */}
      <section
        className="min-h-screen flex flex-col items-center justify-center px-8 py-16 relative"
        style={{
          background: "linear-gradient(to bottom right, #fdfdf8, #f8f9f5)",
        }}
      >
        {/* Background decoration */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-0 right-0 bottom-0 bg-[radial-gradient(circle_at_20%_80%,rgba(168,197,168,0.1)_0%,transparent_50%)]"></div>
          <div className="absolute top-0 left-0 right-0 bottom-0 bg-[radial-gradient(circle_at_80%_20%,rgba(45,95,63,0.05)_0%,transparent_50%)]"></div>
        </div>

        <div className="relative z-10 max-w-3xl mx-auto text-center animate-fadeInDown">
          <div
            className="mb-12 flex justify-center animate-fadeInDown"
            style={{ animationDelay: "0s" }}
          >
            <TallyLogo className="w-28 h-28 drop-shadow-[0_4px_12px_rgba(45,95,63,0.15)]" />
          </div>

          <h1
            className="font-serif text-5xl sm:text-6xl md:text-7xl font-light mb-6 tracking-tight leading-tight animate-fadeInUp"
            style={{ color: "#2d5f3f", animationDelay: "0.2s" }}
          >
            Tally
          </h1>

          <p
            className="text-lg sm:text-xl md:text-2xl mb-12 animate-fadeInUp"
            style={{ color: "rgba(42, 42, 42, 0.8)", animationDelay: "0.4s" }}
          >
            Track what counts. Food journal, autophagy tracker, and your story
            in photos.
          </p>

          <div
            className="flex gap-4 justify-center flex-wrap animate-fadeInUp"
            style={{ animationDelay: "0.6s" }}
          >
            <button
              onClick={() => navigate("/get-started")}
              className="px-10 py-4 text-lg font-medium rounded-xl transition-all duration-300 hover:-translate-y-0.5"
              style={{
                backgroundColor: "#2d5f3f",
                color: "#ffffff",
                boxShadow: "0 4px 20px rgba(45, 95, 63, 0.3)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 6px 30px rgba(45, 95, 63, 0.4)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 4px 20px rgba(45, 95, 63, 0.3)";
              }}
            >
              Get Started
            </button>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-32 px-8 bg-white">
        <div className="max-w-6xl mx-auto">
          <h2
            className="font-serif text-4xl sm:text-5xl font-light text-center mb-20 tracking-tight"
            style={{ color: "#2d5f3f" }}
          >
            Simple tracking, real results
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 mb-20">
            {/* Food Journal */}
            <div
              className="reveal p-10 rounded-2xl border transition-all duration-400 hover:-translate-y-2 hover:shadow-[0_12px_40px_rgba(45,95,63,0.15)]"
              style={{
                backgroundColor: "#f8f9f5",
                borderColor: "rgba(45, 95, 63, 0.1)",
              }}
            >
              <span className="text-4xl block mb-6">📝</span>
              <h3
                className="text-2xl font-semibold mb-4"
                style={{ color: "#2d5f3f" }}
              >
                Food Journal
              </h3>
              <p
                className="text-base leading-relaxed"
                style={{ color: "rgba(42, 42, 42, 0.8)" }}
              >
                AI-powered logging that learns from you. Snap a photo, add a
                note, and let Tally handle the rest.
              </p>
            </div>

            {/* Analytics */}
            <div
              className="reveal p-10 rounded-2xl border transition-all duration-400 hover:-translate-y-2 hover:shadow-[0_12px_40px_rgba(45,95,63,0.15)]"
              style={{
                backgroundColor: "#f8f9f5",
                borderColor: "rgba(45, 95, 63, 0.1)",
              }}
            >
              <span className="text-4xl block mb-6">📊</span>
              <h3
                className="text-2xl font-semibold mb-4"
                style={{ color: "#2d5f3f" }}
              >
                Analytics
              </h3>
              <p
                className="text-base leading-relaxed"
                style={{ color: "rgba(42, 42, 42, 0.8)" }}
              >
                See your calories, patterns, and progress at a glance. Daily,
                weekly, monthly views that actually make sense.
              </p>
            </div>

            {/* Autophagy Tracker */}
            <div
              className="reveal p-10 rounded-2xl border transition-all duration-400 hover:-translate-y-2 hover:shadow-[0_12px_40px_rgba(45,95,63,0.15)]"
              style={{
                backgroundColor: "#f8f9f5",
                borderColor: "rgba(45, 95, 63, 0.1)",
              }}
            >
              <span className="text-4xl block mb-6">⏱️</span>
              <h3
                className="text-2xl font-semibold mb-4"
                style={{ color: "#2d5f3f" }}
              >
                Autophagy Tracker
              </h3>
              <p
                className="text-base leading-relaxed"
                style={{ color: "rgba(42, 42, 42, 0.8)" }}
              >
                Track your fasting windows and see when your body enters
                cellular renewal. Simple, visual, motivating.
              </p>
            </div>

            {/* Rewind */}
            <div
              className="reveal p-10 rounded-2xl border transition-all duration-400 hover:-translate-y-2 hover:shadow-[0_12px_40px_rgba(45,95,63,0.15)]"
              style={{
                backgroundColor: "#f8f9f5",
                borderColor: "rgba(45, 95, 63, 0.1)",
              }}
            >
              <span className="text-4xl block mb-6">📸</span>
              <h3
                className="text-2xl font-semibold mb-4"
                style={{ color: "#2d5f3f" }}
              >
                Rewind
              </h3>
              <p
                className="text-base leading-relaxed"
                style={{ color: "rgba(42, 42, 42, 0.8)" }}
              >
                Your food journey in photos. Scroll back through weeks of meals
                and fasting patterns. Your story, beautifully told.
              </p>
            </div>
          </div>

          {/* Visual Demo */}
          <div className="reveal flex items-center justify-center gap-8 flex-wrap py-12">
            <div className="flex items-end gap-6 h-52">
              <div
                className="w-10 rounded-[20px] shadow-[0_4px_20px_rgba(45,95,63,0.2)] animate-growBar"
                style={{
                  height: "80px",
                  animationDelay: "0.2s",
                  backgroundColor: "#2d5f3f",
                }}
              ></div>
              <div
                className="w-10 rounded-[20px] shadow-[0_4px_20px_rgba(45,95,63,0.2)] animate-growBar"
                style={{
                  height: "140px",
                  animationDelay: "0.4s",
                  backgroundColor: "#2d5f3f",
                }}
              ></div>
              <div
                className="w-10 rounded-[20px] shadow-[0_4px_20px_rgba(45,95,63,0.2)] animate-growBar"
                style={{
                  height: "110px",
                  animationDelay: "0.6s",
                  backgroundColor: "#2d5f3f",
                }}
              ></div>
            </div>
            <div className="max-w-md">
              <h3
                className="font-serif text-3xl mb-4 font-normal"
                style={{ color: "#2d5f3f" }}
              >
                Three bars. Infinite possibilities.
              </h3>
              <p
                className="text-lg leading-relaxed"
                style={{ color: "rgba(42, 42, 42, 0.8)" }}
              >
                Our logo represents the rhythm of your day: eating windows,
                fasting periods, and the balance between nourishment and rest.
                Simple design, profound meaning.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer
        className="py-12 px-8 text-center"
        style={{ backgroundColor: "#2a2a2a", color: "#ffffff" }}
      >
        <p className="opacity-70 text-sm">&copy; 2025 Tally.</p>
      </footer>

      <style>{`
        @keyframes fadeInDown {
          from {
            opacity: 0;
            transform: translateY(-30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes growBar {
          from {
            height: 0;
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        .animate-fadeInDown {
          animation: fadeInDown 0.8s ease-out both;
        }

        .animate-fadeInUp {
          animation: fadeInUp 0.8s ease-out both;
        }

        .animate-growBar {
          animation: growBar 1s ease-out both;
        }

        .reveal {
          opacity: 0;
          transform: translateY(30px);
          transition: all 0.6s ease-out;
        }

        .reveal.active {
          opacity: 1;
          transform: translateY(0);
        }
      `}</style>
    </div>
  );
}
