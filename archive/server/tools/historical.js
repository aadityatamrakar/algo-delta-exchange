const axios = require('axios');

async function getCandles(stock, tf) {
    try {
        const response = await axios.get(`http://localhost:8081/candles`, {
            params: {
                stock: stock,
                tf: tf
            }
        });
        return formatCandlesResponse(response.data);
    } catch (error) {
        console.error('Error fetching candles:', error);
        throw error;
    }
}

function formatCandlesResponse(data) {
    // data = data.map(row => {
    //     let [ts, open, high, low, close, vol] = row;
    //     return {
    //         ts, open, high, low, close, vol
    //     }
    // });
    return data;
}

module.exports = {
    getCandles
};
