import { useParams, Navigate } from "../../../router";
import JournalPage from "./_JournalPage";

export default function JournalDatePage() {
  const { date } = useParams("/app/journal/:date");

  // Parse and validate the date parameter (format: YYYY-MM-DD)
  const parsedDate = new Date(date);

  // If invalid date, redirect to today
  if (!parsedDate) {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const dateParam = `${year}-${month}-${day}`;

    return <Navigate to="/app/journal/:date" params={{ date: dateParam }} />;
  }

  return <JournalPage date={parsedDate} />;
}
