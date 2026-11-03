// The four risk arrays of the Task 6 calculator, shared by mini.spn and its tests.
export const RA_FUT_OCT = [10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 60, -60, 70, -70, 35, -35]
export const RA_FUT_NOV = RA_FUT_OCT.map((v) => v * 1.01)
export const RA_CE = [4, -4, 8, -8, 12, -12, 16, -16, 20, -20, 24, -24, 28, -28, 14, -14]
export const RA_PE = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))
