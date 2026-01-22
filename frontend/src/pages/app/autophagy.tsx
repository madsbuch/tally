import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { db } from "../../lib/database";

export default function AutophagyPage() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const {
    data: lastMeal,
    isLoading: entriesLoading,
    error: entriesError,
  } = useQuery({
    queryKey: ["autophagy"],
    queryFn: async () => {
      return (
        (await db.journalEntries
          .orderBy("insertedAt")
          .reverse()
          .filter(
            (entry) => entry.energyInKCals >= 0 && entry.energyInKCals > 10
          )
          .first()) ?? null
      );
    },
  });

  // Update current time every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Calculate time since last meal
  const timeSinceLastMeal = lastMeal
    ? (currentTime.getTime() - new Date(lastMeal.insertedAt).getTime()) /
      (1000 * 60 * 60) // Hours
    : 0;

  // Calculate hours, minutes, seconds
  const hours = Math.floor(timeSinceLastMeal);
  const minutes = Math.floor((timeSinceLastMeal % 1) * 60);
  const seconds = Math.floor((((timeSinceLastMeal % 1) * 60) % 1) * 60);

  // Define autophagy stages
  const stages = [
    {
      hours: 0,
      name: "Fed State",
      description: "Body is digesting and absorbing nutrients",
      icon: "🍽️",
      animation: "bounce",
    },
    {
      hours: 12,
      name: "Early Fasting",
      description: "Glycogen stores depleted, fat burning begins",
      icon: "⏰",
      animation: "tick-tock",
    },
    {
      hours: 18,
      name: "Fat Burning",
      description: "Enhanced fat burning and ketone production",
      icon: "🔥",
      animation: "flicker",
    },
    {
      hours: 24,
      name: "Autophagy",
      description: "Cellular cleanup process begins",
      icon: "♻️",
      animation: "rotate",
    },
    {
      hours: 48,
      name: "Deep Autophagy",
      description: "Maximum autophagy benefits",
      icon: "✨",
      animation: "sparkle",
    },
    {
      hours: 72,
      name: "Extended Fast",
      description: "Continued autophagy and stem cell production",
      icon: "🧬",
      animation: "pulse-glow",
    },
  ];

  // Find current stage
  const currentStage = stages.reduce((prev, curr) => {
    if (timeSinceLastMeal >= curr.hours) return curr;
    return prev;
  }, stages[0]);

  // Find next stage
  const nextStage =
    stages.find((stage) => stage.hours > timeSinceLastMeal) ||
    stages[stages.length - 1];

  if (entriesLoading) {
    return <div>Loading...</div>;
  }

  if (entriesError) {
    return <div>Error loading journal entries</div>;
  }

  return (
    <div className="py-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Autophagy Tracker</h1>

      {/* Current Stage Card */}
      <div className="bg-white rounded-lg shadow-sm p-6 animate-pulse-subtle">
        <div className="text-sm font-medium text-forest mb-2">
          Current Stage
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {currentStage.name}
        </h2>
        <p className="text-gray-600 mb-4">{currentStage.description}</p>
        <div className="text-sm text-gray-500 transition-all duration-300">
          Fasting for {hours} hours, {minutes} minutes, {seconds} seconds
        </div>
      </div>

      {/* Progress to Next Stage */}
      {currentStage !== stages[stages.length - 1] && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="text-sm font-medium text-forest mb-2">
            Next Stage
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {nextStage.name}
          </h3>
          <div className="w-full bg-gray-200 rounded-full h-2.5 mb-2">
            <div
              className="bg-forest h-2.5 rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(
                  100,
                  (timeSinceLastMeal / nextStage.hours) * 100
                )}%`,
              }}
            ></div>
          </div>
          <div className="text-sm text-gray-500">
            {Math.max(0, Math.ceil(nextStage.hours - timeSinceLastMeal))} hours
            remaining
          </div>
        </div>
      )}

      {/* All Stages Timeline */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Fasting Timeline
        </h3>
        <div className="space-y-4">
          {stages.map((stage) => {
            const isAchieved = timeSinceLastMeal >= stage.hours;
            return (
              <div key={stage.hours} className="flex items-start">
                {isAchieved ? (
                  <div
                    className={`
                      text-2xl mr-3 flex-shrink-0 transition-all duration-300
                      animate-${stage.animation}
                    `}
                  >
                    {stage.icon}
                  </div>
                ) : (
                  <div className="w-4 h-4 rounded-full mt-1 mr-3 flex-shrink-0 bg-gray-200"></div>
                )}
                <div>
                  <div className="font-medium text-gray-900">
                    {stage.hours}h - {stage.name}
                  </div>
                  <div className="text-sm text-gray-500">
                    {stage.description}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
