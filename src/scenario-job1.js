import { scenarioJob1V } from './scenario-job1v';

// Горизонтальная legacy-композиция переиспользует тот же нейтральный fixture.
export const scenarioJob1 = {
  ...scenarioJob1V,
  width: 1870,
  height: 1080,
};
