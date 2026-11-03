
/**
 * @description Calculate Bollinger Bands percentage
 * @param {Object} data - The data object containing close prices and Bollinger Bands
 * @returns {Array} - The Bollinger Bands percentage
 */
module.exports = function calculateBbandsPercentage(data) {
    const { close, bbands } = data;
    const percentage = close.map((price, index) => {
        const lower = bbands.lower[index];
        const upper = bbands.upper[index];
        if (upper == 0  && lower == 0) return 0;
        else return ((price - lower) / (upper - lower)) * 100;
    });
    return percentage;
};
