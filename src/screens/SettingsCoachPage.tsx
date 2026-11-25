import CoachSettings from "../components/CoachSettings";
import CoachCostSettings from "../components/CoachCostSettings";
import SettingsFolder from "../components/SettingsFolder";

// Spec: SET-1
/** Settings → Coach: what the coach is for, how it talks, when it checks in, and its model. */
export default function SettingsCoachPage() {
  return (
    <SettingsFolder title="Coach">
      <CoachSettings />
      <CoachCostSettings />
    </SettingsFolder>
  );
}
