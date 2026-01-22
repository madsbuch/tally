# Requirements

## Functional Requirements

1. **Meal logging**

   - Capture a photo of a meal
   - Add optional text description
   - Save record with timestamp and nutritional estimate (from AI)

2. **Exercise logging**

   - Capture a screenshot (e.g. Garmin Connect)
   - Add optional text description
   - Save record with timestamp and calorie burn estimate (from AI)

3. **Daily budget tracking**

   - Configurable daily calorie budget (default 1500 kcal)
   - Daily net budget = base budget + exercise calories - meal calories
   - Display running total and remaining budget

4. **AI integration**

   - Direct call to OpenAI API (user provides API key)
   - API used for:
     - Estimating calories/macros from meal (photo + text)
     - Estimating calorie burn from exercise (screenshot + text)

5. **Configuration**
   - Store API key locally
   - Store daily base calorie budget locally

## Non-functional Requirements

- Offline-first: must work without network (except AI calls)
- No backend: all storage and logic local to the device
- Data persistence: use SQLite with OPFS for meals, exercises, and config
- Radical simplicity: no extra features (no weight tracking, no exports, no charts)
- Low maintenance: no servers to run, minimal dependencies
- Privacy: all data remains on the device, no third-party sync
- Only mobile phone: Desktop is not a target for the app
