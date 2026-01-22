import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import JournalCard from "../../../components/JournalCard";
import { db, getConfig } from "../../../lib/database";
import { Link, useNavigate } from "../../../router";

interface JournalPageProps {
  date: Date;
}

export default function JournalPage({ date }: JournalPageProps) {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const {
    data: journal = [],
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: ["journal_for_day", date.toISOString()],
    queryFn: async () => {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const entries = await db.journalEntries
        // Implicitly ordered by insertedAt
        .where("insertedAt")
        .between(startOfDay, endOfDay)
        .reverse()
        .toArray();

      return entries;
    },
  });

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
  });

  if (queryError) {
    setError(
      queryError instanceof Error
        ? queryError.message
        : "Failed to load entries"
    );
  }

  const formatDateParam = (d: Date): string => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const goToPreviousDay = () => {
    const newDate = new Date(date);
    newDate.setDate(date.getDate() - 1);
    navigate("/app/journal/:date", {
      params: { date: formatDateParam(newDate) },
    });
  };

  const goToNextDay = () => {
    const newDate = new Date(date);
    newDate.setDate(date.getDate() + 1);
    navigate("/app/journal/:date", {
      params: { date: formatDateParam(newDate) },
    });
  };

  const goToToday = () => {
    navigate("/app/journal");
  };

  const isToday =
    date.toISOString().split("T")[0] === new Date().toISOString().split("T")[0];

  // Separate consumed (positive) and burned (negative) calories
  const totalConsumedCalories = journal.reduce(
    (sum, entry) => sum + (entry.energyInKCals > 0 ? entry.energyInKCals : 0),
    0
  );
  const totalBurnedCalories = journal.reduce(
    (sum, entry) =>
      sum + (entry.energyInKCals < 0 ? Math.abs(entry.energyInKCals) : 0),
    0
  );
  const dailyBudget = config?.dailyEnergyInKCalTarget ?? 2000;

  // Net calories is how much I have netto consumed today, which is consumes - burned
  // Should not be mixed up with "Calories left"
  const netCalories = totalConsumedCalories - totalBurnedCalories;
  const remainingCalories =
    dailyBudget + totalBurnedCalories - totalConsumedCalories;

  return (
    <div className="py-6">
      {/* Header section */}
      <div className="space-y-6 mb-6">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">Food Journal</h1>
        </div>

        <div className="flex items-center justify-between space-x-4">
          <button
            onClick={goToPreviousDay}
            className="p-2 rounded-full hover:bg-gray-100 w-9 h-9 flex items-center justify-center"
          >
            <svg
              className="w-5 h-5 text-gray-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>

          <div className="flex items-center space-x-3">
            <span className="text-sm font-medium w-32 text-center">
              {isToday
                ? "Today"
                : date.toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
            </span>

            {!isToday && (
              <button
                onClick={goToToday}
                className="p-1.5 rounded-full hover:bg-gray-100 text-gray-600 w-8 h-8 flex items-center justify-center"
                title="Jump to today"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </button>
            )}
          </div>

          <button
            onClick={goToNextDay}
            disabled={isToday}
            className={`p-2 rounded-full w-9 h-9 flex items-center justify-center ${
              isToday ? "text-gray-300" : "hover:bg-gray-100 text-gray-600"
            }`}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        </div>

        {/* Calories Display */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="text-center mb-4">
            <div className="text-2xl font-bold text-gray-900">
              {remainingCalories > 0 ? remainingCalories : 0}
            </div>
            <div className="text-sm text-gray-600">
              {remainingCalories > 0
                ? "calories remaining"
                : remainingCalories < 0
                ? `${Math.abs(remainingCalories)} calories over budget`
                : "budget met"}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-center border-t border-gray-100 pt-4">
            <div>
              <div className="text-xs text-gray-500">Budget</div>
              <div className="text-sm font-medium text-gray-900">
                {dailyBudget}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Consumed</div>
              <div className="text-sm font-medium text-gray-900">
                {totalConsumedCalories}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Burned</div>
              <div className="text-sm font-medium text-gray-900">
                {totalBurnedCalories}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Net</div>
              <div className="text-sm font-medium text-gray-900">
                {netCalories}
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && <div className="text-red-500 mb-6">{error}</div>}

      {isLoading ? (
        <div className="text-center py-8 text-gray-500">Loading journal...</div>
      ) : journal.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <p>No entries recorded for this day.</p>
          {isToday && (
            <p className="text-sm mt-1">
              Add your first meal or activity to start tracking!
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {journal.map((meal) => (
            <Link
              key={meal.id}
              to="/app/summary/:id"
              params={{ id: meal.id.toString() }}
            >
              <JournalCard entry={meal} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
