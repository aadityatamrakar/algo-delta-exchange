const fs = require('fs');
const csv = require('csv-parser');

function filterInstruments() {
    const csvFilePath = '/Users/aaditya/Downloads/instruments (2).csv';
    const filteredData = [];
    const filterStocks = JSON.parse(fs.readFileSync('stock_data.json', 'utf8'));
    const instrument_map = filterStocks.reduce((acc, s) => {
        acc[s.id] = s
        return acc;
    }, {});
    const instrument_ids = Object.keys(instrument_map);
    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (row) => {
            const filteredRow = {
                instrument_token: row.instrument_token,
                exchange_token: row.exchange_token,
                tradingsymbol: row.tradingsymbol,
                name: row.name,
                exchange: row.exchange,
                type: instrument_map[row.exchange_token] ? instrument_map[row.exchange_token].SctySrs : ""
            };

            if (instrument_ids.includes(row.exchange_token)) {
                filteredData.push(filteredRow);
            }
        })
        .on('end', () => {
            // Write to JSON file
            console.log("length", filteredData.length);
            fs.writeFileSync('stock_bse.json', JSON.stringify(filteredData, null, 2));
            console.log('Processing complete! Data saved to stock_data.json');

            // print ids that are not found and there symbols
            const foundIds = filteredData.map((s) => s.exchange_token);
            const notFoundIds = instrument_ids.filter((id) => !foundIds.includes(id));
            console.log("not found ids", notFoundIds);
            const notFoundSymbols = filterStocks.filter((s) => notFoundIds.includes(s.id));
            console.log("not found symbols", notFoundSymbols);
            // save not found symbols
            fs.writeFileSync('stock_not_found.json', JSON.stringify(notFoundSymbols, null, 2));
        })
        .on('error', (error) => {
            console.error('Error processing CSV:', error.message);
        });
}


function filterBSE(cb) {
    const csvFilePath = '/Users/aaditya/Downloads/BhavCopy_BSE_CM_0_0_0_20250210_F_0000.CSV';
    const filteredData = [];
    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (row) => {
            // Extract only required fields
            const filteredRow = {
                id: row.FinInstrmId,
                TckrSymb: row.TckrSymb,
                SctySrs: row.SctySrs
            };

            // BSE: A,B,XT,M,MT
            if (['A', 'B', 'XT', 'M', 'MT'].includes(row.SctySrs)) {
                filteredData.push(filteredRow);
            }
        })
        .on('end', () => {
            // Write to JSON file
            console.log("length", filteredData.length);
            fs.writeFileSync('stock_data.json', JSON.stringify(filteredData, null, 2));
            console.log('Processing complete! Data saved to stock_data.json');
        })
        .on('error', (error) => {
            console.error('Error processing CSV:', error.message);
        });
        if(cb) cb();
}

filterBSE(filterInstruments);
