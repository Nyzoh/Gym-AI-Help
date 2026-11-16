'use strict';

// Fixed example plan returned by /api/plan when MOCK_AI=1.
const MOCK_PLAN = {
  summary:
    'Mock plan (MOCK_AI=1): a balanced 4-day upper/lower split focused on compound lifts, with a moderate calorie target and high protein.',
  weeklyPlan: [
    {
      day: 'Day 1',
      focus: 'Upper body (push emphasis)',
      exercises: [
        { name: 'Bench press', sets: '4', reps: '6-8', rest: '120s' },
        { name: 'Overhead press', sets: '3', reps: '8-10', rest: '90s' },
        { name: 'Incline dumbbell press', sets: '3', reps: '10-12', rest: '75s' },
        { name: 'Lateral raise', sets: '3', reps: '12-15', rest: '60s' },
        { name: 'Triceps pushdown', sets: '3', reps: '10-12', rest: '60s' },
      ],
    },
    {
      day: 'Day 2',
      focus: 'Lower body (squat emphasis)',
      exercises: [
        { name: 'Back squat', sets: '4', reps: '6-8', rest: '150s' },
        { name: 'Romanian deadlift', sets: '3', reps: '8-10', rest: '120s' },
        { name: 'Walking lunge', sets: '3', reps: '10 per leg', rest: '90s' },
        { name: 'Calf raise', sets: '3', reps: '12-15', rest: '60s' },
        { name: 'Plank', sets: '3', reps: '45s', rest: '45s' },
      ],
    },
    {
      day: 'Day 3',
      focus: 'Upper body (pull emphasis)',
      exercises: [
        { name: 'Pull-up or lat pulldown', sets: '4', reps: '6-10', rest: '120s' },
        { name: 'Barbell row', sets: '3', reps: '8-10', rest: '90s' },
        { name: 'Seated cable row', sets: '3', reps: '10-12', rest: '75s' },
        { name: 'Face pull', sets: '3', reps: '12-15', rest: '60s' },
        { name: 'Dumbbell curl', sets: '3', reps: '10-12', rest: '60s' },
      ],
    },
    {
      day: 'Day 4',
      focus: 'Lower body (hinge emphasis) + conditioning',
      exercises: [
        { name: 'Deadlift', sets: '3', reps: '5', rest: '180s' },
        { name: 'Leg press', sets: '3', reps: '10-12', rest: '90s' },
        { name: 'Leg curl', sets: '3', reps: '10-12', rest: '75s' },
        { name: 'Hanging knee raise', sets: '3', reps: '10-15', rest: '60s' },
        { name: 'Easy bike or incline walk', sets: '1', reps: '15 min', rest: '-' },
      ],
    },
  ],
  nutrition: {
    calories: '2400 kcal/day',
    protein: '150 g/day',
    tips: [
      'Include a protein source (eggs, chicken, fish, dairy, beans) in every meal.',
      'Eat a carb-rich meal 1-3 hours before training.',
      'Aim for at least 2 litres of water per day.',
      'Keep vegetables or fruit in at least two meals per day.',
    ],
  },
  safetyNotes: [
    'Warm up for 5-10 minutes and do lighter ramp-up sets before heavy lifts.',
    'Stop if you feel sharp pain. Consult a doctor or physiotherapist about any injury before training.',
    'This is general fitness guidance, not medical advice.',
  ],
};

module.exports = { MOCK_PLAN };
