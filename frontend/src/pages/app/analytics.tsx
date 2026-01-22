import { useMemo, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { db, getConfig, JournalEntry } from "../../lib/database";

// Helper function to get start of week (Monday)
export function getStartOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Helper function to get start of month
export function getStartOfMonth(date: Date): Date {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Helper function to filter entries by date range
function filterEntriesByDateRange(
  entries: JournalEntry[],
  startDate: Date,
  endDate: Date,
): JournalEntry[] {
  return entries.filter((entry) => {
    const entryDate = new Date(entry.insertedAt);
    return entryDate >= startDate && entryDate <= endDate;
  });
}

// Month in JavaScript is 0-indexed (January is 0, February is 1, etc),
// but by using 0 as the day it will give us the last day of the prior
// month. So passing in 1 as the month number will return the last day
// of January, not February
function totalDaysInMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
);

// Animated Macro Background Component
function AnimatedMacroBackground({
  proteinPct,
  carbsPct,
  fatPct,
}: {
  proteinPct: number;
  carbsPct: number;
  fatPct: number;
}) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    // Trigger animation after component mounts
    const timer = setTimeout(() => setAnimated(true), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="absolute inset-0 flex items-end justify-center px-6 pb-6 opacity-[0.12] pointer-events-none">
      <div className="w-full max-w-md h-32 flex items-end justify-center gap-4">
        {/* Protein Bar */}
        <div className="flex flex-col items-center flex-1 h-full justify-end">
          <div
            className="w-full bg-gradient-to-t from-red-500 via-red-400 to-red-300 rounded-t-lg transition-all duration-1000 ease-out shadow-lg"
            style={{
              height: animated ? `${proteinPct}%` : "0%",
            }}
          />
        </div>
        {/* Carbs Bar */}

        <div className="flex flex-col items-center flex-1 h-full justify-end">
          <div
            className="w-full bg-gradient-to-t from-green-500 via-green-400 to-green-300 rounded-t-lg transition-all duration-1000 ease-out delay-150 shadow-lg"
            style={{
              height: animated ? `${carbsPct}%` : "0%",
            }}
          />
        </div>
        {/* Fat Bar */}
        <div className="flex flex-col items-center flex-1 h-full justify-end">
          <div
            className="w-full bg-gradient-to-t from-yellow-500 via-yellow-400 to-yellow-300 rounded-t-lg transition-all duration-1000 ease-out delay-300 shadow-lg"
            style={{
              height: animated ? `${fatPct}%` : "0%",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// Progress Card Component
function ProgressCard({
  title,
  entries,
  calorieTarget,
  startDate,
  endDate,
}: {
  title: string;
  entries: JournalEntry[];
  calorieTarget: number;
  startDate: Date;
  endDate: Date;
}) {
  const [showExplainer, setShowExplainer] = useState(false);

  // Calculate missing days if date range is provided
  let daysSoFarInPeriod = 0;
  let daysSoFarWithEntries = 0;
  let missingDaysSoFar = 0;

  // Calculate total days in range
  daysSoFarInPeriod = Math.ceil(
    // This approach works across months
    (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
  );

  // Find unique days with entries
  const daysWithEntriesSet = new Set<string>();
  entries.forEach((entry) => {
    const entryDate = new Date(entry.insertedAt);
    daysWithEntriesSet.add(entryDate.toDateString());
  });
  daysSoFarWithEntries = daysWithEntriesSet.size;
  missingDaysSoFar = daysSoFarInPeriod - daysSoFarWithEntries;

  const caloriesConsumerSoFar = entries.reduce(
    (sum, entry) => sum + (entry.energyInKCals > 0 ? entry.energyInKCals : 0),
    0,
  );

  const CaloriesBurnedSoFar = entries.reduce(
    (sum, entry) =>
      sum + (entry.energyInKCals < 0 ? Math.abs(entry.energyInKCals) : 0),
    0,
  );

  const net = caloriesConsumerSoFar - CaloriesBurnedSoFar;
  const remainingCalories =
    calorieTarget + CaloriesBurnedSoFar - caloriesConsumerSoFar;

  const protein = entries.reduce(
    (sum, entry) => sum + (entry.proteinInGrams ?? 0),
    0,
  );
  const carbs = entries.reduce(
    (sum, entry) => sum + (entry.carbsInGrams ?? 0),
    0,
  );
  const fat = entries.reduce((sum, entry) => sum + (entry.fatInGrams ?? 0), 0);

  const proteinCals = protein * 4;
  const carbsCals = carbs * 4;
  const fatCals = fat * 9;
  const totalMacroCals = proteinCals + carbsCals + fatCals;

  console.log(proteinCals, carbsCals, fatCals, totalMacroCals);

  const proteinPct = (proteinCals / totalMacroCals) * 100;
  const carbsPct = (carbsCals / totalMacroCals) * 100;
  const fatPct = (fatCals / totalMacroCals) * 100;

  console.log("proteinPct", proteinPct);
  console.log("carbsPct", carbsPct);
  console.log("fatPct", fatPct);

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 relative overflow-hidden">
      <h2 className="text-lg font-semibold text-gray-900 mb-4 relative z-10">
        {title}
      </h2>

      <AnimatedMacroBackground
        proteinPct={proteinPct}
        carbsPct={carbsPct}
        fatPct={fatPct}
      />

      <div className="text-center mb-4 relative z-10">
        <div className="text-2xl font-bold text-gray-900">
          {Math.round(remainingCalories > 0 ? remainingCalories : 0)}
        </div>
        <div className="text-sm text-gray-600">
          {remainingCalories > 0
            ? "calories remaining"
            : remainingCalories < 0
              ? `${Math.abs(Math.round(remainingCalories))} calories over budget`
              : "budget met"}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-center border-t border-gray-100 pt-4 mb-4 relative z-10">
        <div>
          <div className="text-xs text-gray-500">Target</div>
          <div className="text-sm font-medium text-gray-900">
            {calorieTarget}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Consumed</div>
          <div className="text-sm font-medium text-gray-900">
            {Math.round(caloriesConsumerSoFar)}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Burned</div>
          <div className="text-sm font-medium text-gray-900">
            {Math.round(CaloriesBurnedSoFar)}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Net</div>
          <div className="text-sm font-medium text-gray-900">
            {Math.round(net)}
          </div>
        </div>
      </div>

      <div className="border-t border-gray-100 pt-4 relative z-10">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Macros</h3>
        <div className="grid grid-cols-3 gap-4 mb-3">
          <div className="text-center">
            <div className="text-lg font-bold text-gray-900">
              {Math.round(protein)}g
            </div>
            <div className="text-xs text-gray-500">
              ({Math.round(proteinCals)} kcal)
            </div>
            <div className="flex items-center justify-center gap-1 text-xs text-gray-600 mt-1">
              <div className="w-2 h-2 rounded-sm bg-gradient-to-br from-red-400 to-red-600" />
              Protein
            </div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-gray-900">
              {Math.round(carbs)}g
            </div>
            <div className="text-xs text-gray-500">
              ({Math.round(carbsCals)} kcal)
            </div>
            <div className="flex items-center justify-center gap-1 text-xs text-gray-600 mt-1">
              <div className="w-2 h-2 rounded-sm bg-gradient-to-br from-green-400 to-green-600" />
              Carbs
            </div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-gray-900">
              {Math.round(fat)}g
            </div>
            <div className="text-xs text-gray-500">
              ({Math.round(fatCals)} kcal)
            </div>
            <div className="flex items-center justify-center gap-1 text-xs text-gray-600 mt-1">
              <div className="w-2 h-2 rounded-sm bg-gradient-to-br from-yellow-400 to-yellow-600" />
              Fat
            </div>
          </div>
        </div>
        <div className="border-t border-gray-100 pt-2">
          <button
            onClick={() => setShowExplainer(!showExplainer)}
            className="w-full text-center text-sm text-gray-600 hover:text-gray-900 transition-colors flex items-center justify-center gap-1"
          >
            Total from Macros:{" "}
            <span className="font-medium text-gray-900">
              {Math.round(totalMacroCals)} kcal
            </span>
            <svg
              className="w-4 h-4 text-gray-400"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clipRule="evenodd"
              />
            </svg>
          </button>

          {showExplainer && (
            <div className="mt-2 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-gray-700">
              <p className="font-medium text-blue-900 mb-2">
                Macro Calorie Calculation:
              </p>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span>• Protein: {Math.round(protein)}g × 4 kcal/g</span>
                  <span className="font-medium">
                    {Math.round(proteinCals)} kcal
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>• Carbs: {Math.round(carbs)}g × 4 kcal/g</span>
                  <span className="font-medium">
                    {Math.round(carbsCals)} kcal
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>• Fat: {Math.round(fat)}g × 9 kcal/g</span>
                  <span className="font-medium">
                    {Math.round(fatCals)} kcal
                  </span>
                </div>
                <div className="flex justify-between pt-1 border-t border-blue-200 mt-1">
                  <span className="font-medium">Total:</span>
                  <span className="font-medium">
                    {Math.round(totalMacroCals)} kcal
                  </span>
                </div>
              </div>
              <p className="text-gray-600 mt-2 italic">
                Note: This may differ from "Consumed" due to rounding or
                incomplete macro data from AI.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Missing Days Warning */}
      {missingDaysSoFar > 0 && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg relative z-10">
          <div className="flex items-start gap-2">
            <svg
              className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">
                Incomplete logging detected
              </p>
              <p className="text-sm text-amber-700 mt-1">
                {missingDaysSoFar} of {daysSoFarInPeriod} days in this period
                have no entries. Budget calculation assumes logging on all days.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const {
    data: journalEntries = [],
    isLoading: entriesLoading,
    error: entriesError,
  } = useQuery({
    queryKey: ["journal_entries"],
    queryFn: async () => {
      // Fetch entries from the start of the current month to support monthly view
      const today = new Date();
      const startDate = getStartOfMonth(today);

      return await db.journalEntries
        .where("insertedAt")
        .aboveOrEqual(startDate)
        .toArray();
    },
  });

  const { data: userSettings } = useQuery({
    queryKey: ["user_settings"],
    queryFn: async () => {
      return await getConfig();
    },
  });

  // Get metabolic rate from user settings or default to 2000
  const calorieTarget = userSettings?.dailyEnergyInKCalTarget ?? 2000;

  // Calculate the last 7 days of data (or fewer if less data available)
  const data = useMemo(() => {
    // Group entries by date
    const entriesByDate = new Map<string, JournalEntry[]>();
    journalEntries.forEach((entry) => {
      const dateKey = new Date(entry.insertedAt).toDateString();
      if (!entriesByDate.has(dateKey)) {
        entriesByDate.set(dateKey, []);
      }
      entriesByDate.get(dateKey)!.push(entry);
    });

    // Calculate actual days with data
    let actualDays = 0;
    if (journalEntries.length > 0) {
      const oldestEntry = journalEntries.reduce((oldest, entry) => {
        return entry.insertedAt < oldest.insertedAt ? entry : oldest;
      });
      const oldestDate = new Date(oldestEntry.insertedAt);
      const today = new Date();
      const daysDiff = Math.floor(
        (today.getTime() - oldestDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      actualDays = Math.min(7, daysDiff + 1); // +1 to include today
    }

    // Get date range based on actual days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(
      endDate.getDate() - (actualDays > 0 ? actualDays - 1 : 0),
    );

    // Generate array of dates and calculate metrics
    const dates = [];
    const netCalories = [];
    const consumedCalories = [];
    const burnedCalories = [];
    const remainingCalories = [];
    const dailyProtein = [];
    const dailyCarbs = [];
    const dailyFat = [];

    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const dateStr = currentDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      dates.push(dateStr);

      // Get entries for this day
      const dayEntries = entriesByDate.get(currentDate.toDateString()) || [];

      // Sum up meal calories and exercise calories
      let mealCalories = 0;
      let exerciseCalories = 0;
      let protein = 0;
      let carbs = 0;
      let fat = 0;

      dayEntries.forEach((entry) => {
        if (entry.energyInKCals >= 0) {
          // Meal
          mealCalories += entry.energyInKCals;
          protein += entry.proteinInGrams || 0;
          carbs += entry.carbsInGrams || 0;
          fat += entry.fatInGrams || 0;
        } else {
          // Exercise
          exerciseCalories += Math.abs(entry.energyInKCals);
        }
      });

      // Net calories = meal calories - exercise calories
      const netDayCalories = mealCalories - exerciseCalories;

      netCalories.push(netDayCalories);
      consumedCalories.push(mealCalories);
      burnedCalories.push(exerciseCalories);
      remainingCalories.push(calorieTarget - netDayCalories);
      dailyProtein.push(protein);
      dailyCarbs.push(carbs);
      dailyFat.push(fat);

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Calculate rolling sum for actual period
    const periodNetCalories = netCalories.reduce((sum, cal) => sum + cal, 0);

    return {
      dates,
      netCalories,
      consumedCalories,
      burnedCalories,
      remainingCalories,
      dailyProtein,
      dailyCarbs,
      dailyFat,
      periodNetCalories,
      actualDays,
    };
  }, [journalEntries, calorieTarget]);

  if (entriesLoading) {
    return <div>Loading...</div>;
  }

  if (entriesError) {
    return <div>Error loading journal entries</div>;
  }

  return (
    <div className="py-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>

      {/* Today's Progress */}
      {(() => {
        const today = new Date();
        const todayStart = new Date(today);
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(today);
        todayEnd.setHours(23, 59, 59, 999);
        const todayEntries = filterEntriesByDateRange(
          journalEntries,
          todayStart,
          todayEnd,
        );
        return (
          <ProgressCard
            title="Today's Progress"
            entries={todayEntries}
            calorieTarget={calorieTarget}
            startDate={todayStart}
            endDate={todayEnd}
          />
        );
      })()}

      {/* This Week's Progress */}
      {(() => {
        const today = new Date();
        const weekStart = getStartOfWeek(today);
        const weekEnd = new Date(today);
        weekEnd.setHours(23, 59, 59, 999);
        const weekEntries = filterEntriesByDateRange(
          journalEntries,
          weekStart,
          weekEnd,
        );

        return (
          <ProgressCard
            title="Week's Progress (Starting Monday)"
            entries={weekEntries}
            // We show the entire target for the entire week
            calorieTarget={calorieTarget * 7}
            startDate={weekStart}
            endDate={weekEnd}
          />
        );
      })()}

      {/* This Month's Progress */}
      {(() => {
        const today = new Date();
        const monthStart = getStartOfMonth(today);
        const monthEnd = new Date(today);
        monthEnd.setHours(23, 59, 59, 999);
        const monthEntries = filterEntriesByDateRange(
          journalEntries,
          monthStart,
          monthEnd,
        );
        // Calculate days in current month so far
        const totalDaysInThisMonth = totalDaysInMonth(today);
        return (
          <ProgressCard
            title={`Month's Progress (${totalDaysInThisMonth} days)`}
            entries={monthEntries}
            calorieTarget={calorieTarget * totalDaysInThisMonth}
            startDate={monthStart}
            endDate={monthEnd}
          />
        );
      })()}

      {/* Daily Calories Chart */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">
          Daily Calorie Intake
        </h2>
        <div className="text-xs text-gray-500 mb-4">Last 7 days</div>
        <div className="h-64">
          <Line
            data={{
              labels: data.dates,
              datasets: [
                {
                  label: "Net Calories",
                  data: data.netCalories,
                  borderColor: "rgb(99, 102, 241)",
                  backgroundColor: "rgba(99, 102, 241, 0.05)",
                  borderWidth: 2,
                  tension: 0.4,
                  fill: false,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                  pointBackgroundColor: "rgb(99, 102, 241)",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 2,
                },
                {
                  label: "Consumed",
                  data: data.consumedCalories,
                  borderColor: "rgb(34, 197, 94)",
                  backgroundColor: "rgba(34, 197, 94, 0.05)",
                  borderWidth: 2,
                  tension: 0.4,
                  fill: false,
                  pointRadius: 2,
                  pointHoverRadius: 4,
                  pointBackgroundColor: "rgb(34, 197, 94)",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 1,
                },
                {
                  label: "Burned",
                  data: data.burnedCalories,
                  borderColor: "rgb(239, 68, 68)",
                  backgroundColor: "rgba(239, 68, 68, 0.05)",
                  borderWidth: 2,
                  tension: 0.4,
                  fill: false,
                  pointRadius: 2,
                  pointHoverRadius: 4,
                  pointBackgroundColor: "rgb(239, 68, 68)",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 1,
                },
                {
                  label: "Remaining",
                  data: data.remainingCalories,
                  borderColor: "rgb(168, 85, 247)",
                  backgroundColor: "rgba(168, 85, 247, 0.05)",
                  borderWidth: 2,
                  tension: 0.4,
                  fill: false,
                  pointRadius: 2,
                  pointHoverRadius: 4,
                  pointBackgroundColor: "rgb(168, 85, 247)",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 1,
                },
              ],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: {
                  display: true,
                  position: "top" as const,
                  align: "end",
                  labels: {
                    usePointStyle: true,
                    pointStyle: "circle",
                    padding: 12,
                    font: { size: 11, weight: 500 },
                    color: "#6b7280",
                  },
                },
                tooltip: {
                  backgroundColor: "rgba(0, 0, 0, 0.8)",
                  padding: 12,
                  cornerRadius: 8,
                  titleFont: { size: 12, weight: 600 },
                  bodyFont: { size: 13 },
                  callbacks: {
                    label: (context) =>
                      `${context.dataset.label ?? ""}: ${Math.round(
                        context.parsed.y,
                      )} kcal`,
                  },
                },
              },
              scales: {
                x: {
                  grid: {
                    display: false,
                  },
                  ticks: {
                    font: { size: 11 },
                    color: "#9ca3af",
                  },
                },
                y: {
                  grid: {
                    color: "rgba(0, 0, 0, 0.05)",
                  },
                  ticks: {
                    font: { size: 11 },
                    color: "#9ca3af",
                    padding: 8,
                  },
                  border: {
                    display: false,
                  },
                },
              },
              interaction: {
                intersect: false,
                mode: "index",
              },
            }}
          />
        </div>
      </div>

      {/* Macros Chart */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">
          Macros Over Time
        </h2>
        <div className="text-xs text-gray-500 mb-4">Last 7 days</div>
        <div className="h-48">
          <Line
            data={{
              labels: data.dates,
              datasets: [
                {
                  label: "Protein",
                  data: data.dailyProtein,
                  borderColor: "rgb(239, 68, 68)",
                  backgroundColor: "rgba(239, 68, 68, 0.05)",
                  borderWidth: 2,
                  tension: 0.4,
                  fill: true,
                  pointRadius: 2,
                  pointHoverRadius: 4,
                  pointBackgroundColor: "rgb(239, 68, 68)",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 1,
                },
                {
                  label: "Carbs",
                  data: data.dailyCarbs,
                  borderColor: "rgb(34, 197, 94)",
                  backgroundColor: "rgba(34, 197, 94, 0.05)",
                  borderWidth: 2,
                  tension: 0.4,
                  fill: true,
                  pointRadius: 2,
                  pointHoverRadius: 4,
                  pointBackgroundColor: "rgb(34, 197, 94)",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 1,
                },
                {
                  label: "Fat",
                  data: data.dailyFat,
                  borderColor: "rgb(234, 179, 8)",
                  backgroundColor: "rgba(234, 179, 8, 0.05)",
                  borderWidth: 2,
                  tension: 0.4,
                  fill: true,
                  pointRadius: 2,
                  pointHoverRadius: 4,
                  pointBackgroundColor: "rgb(234, 179, 8)",
                  pointBorderColor: "#fff",
                  pointBorderWidth: 1,
                },
              ],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: {
                  display: true,
                  position: "top" as const,
                  align: "end",
                  labels: {
                    usePointStyle: true,
                    pointStyle: "circle",
                    padding: 12,
                    font: { size: 11, weight: 500 },
                    color: "#6b7280",
                  },
                },
                tooltip: {
                  backgroundColor: "rgba(0, 0, 0, 0.8)",
                  padding: 12,
                  cornerRadius: 8,
                  titleFont: { size: 12, weight: 600 },
                  bodyFont: { size: 13 },
                  callbacks: {
                    label: (context) =>
                      `${context.dataset.label}: ${Math.round(
                        context.parsed.y,
                      )}g`,
                  },
                },
              },
              scales: {
                x: {
                  grid: {
                    display: false,
                  },
                  ticks: {
                    font: { size: 11 },
                    color: "#9ca3af",
                  },
                },
                y: {
                  min: 0,
                  grid: {
                    color: "rgba(0, 0, 0, 0.05)",
                  },
                  ticks: {
                    font: { size: 11 },
                    color: "#9ca3af",
                    padding: 8,
                  },
                  border: {
                    display: false,
                  },
                },
              },
              interaction: {
                intersect: false,
                mode: "index",
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
