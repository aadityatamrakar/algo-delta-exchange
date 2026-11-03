/**
 * 
 * {
    "_id" : ObjectId("63a281afae25ea239673c21a"),
    "updateTs" : ISODate("2022-12-21T03:46:55.267+0000"),
    "updateType" : "order",
    "strategy" : "Lion_ZZJ4351",
    "params" : [
        "0"
    ],
    "status" : "Filled",
    "price" : "133.26",
    "LoginID" : "ZZJ4351",
    "ClientID" : "M6000",
    "AppOrderID" : 1200028704.0,
    "OrderReferenceID" : "",
    "GeneratedBy" : "TWSAPI",
    "ExchangeOrderID" : "1500000001303405",
    "OrderCategoryType" : "NORMAL",
    "ExchangeSegment" : "NSEFO",
    "ExchangeInstrumentID" : 51466.0,
    "OrderSide" : "Sell",
    "OrderType" : "Market",
    "ProductType" : "NRML",
    "TimeInForce" : "DAY",
    "OrderPrice" : 0.0,
    "OrderQuantity" : 900.0,
    "OrderStopPrice" : 0.0,
    "OrderStatus" : "Filled",
    "OrderAverageTradedPrice" : "133.26",
    "LeavesQuantity" : 0.0,
    "CumulativeQuantity" : 900.0,
    "OrderDisclosedQuantity" : 0.0,
    "OrderGeneratedDateTime" : "2022-12-21T09:15:45.8900044",
    "ExchangeTransactTime" : "2022-12-21T09:16:55+05:30",
    "LastUpdateDateTime" : "2022-12-21T09:15:45.9210047",
    "OrderExpiryDate" : "1980-01-01T00:00:00",
    "CancelRejectReason" : "",
    "OrderUniqueIdentifier" : "Lion_ZZJ4351|0",
    "OrderLegStatus" : "SingleOrderLeg",
    "IsSpread" : false,
    "BoLegDetails" : 0.0,
    "BoEntryOrderId" : "",
    "OrderAverageTradedPriceAPI" : 133.25555555555556,
    "OrderSideAPI" : "SELL",
    "OrderGeneratedDateTimeAPI" : "21-12-2022 09:15:45",
    "ExchangeTransactTimeAPI" : "21-12-2022 09:16:55",
    "LastUpdateDateTimeAPI" : "21-12-2022 09:15:45",
    "OrderExpiryDateAPI" : "01-01-1980 00:00:00",
    "MessageCode" : 9004.0,
    "MessageVersion" : 4.0,
    "TokenID" : 0.0,
    "ApplicationType" : 146.0,
    "SequenceNumber" : NumberLong(937740018031655)
}
 */

const buildPositionSymbol = function (order) {
    let position = {};
    if (order.isBuilt) {
        if (order.transaction_type == 'SELL') {
            position.quantity += -1 * order.quantity;
            position.sell_quantity += order.quantity;
            position.sell_value += Math.round(order.quantity * order.average_price);
            position.sell_price = Math.round(position.sell_value / position.sell_quantity * 100) / 100;
        } else {
            position.quantity += order.quantity;
            position.buy_quantity += order.quantity;
            position.buy_value += Math.round(order.quantity * order.average_price);
            position.buy_price = Math.round(position.buy_value / position.buy_quantity * 100) / 100;
        }
    } else {
        position = {
            "tradingsymbol": order.tradingsymbol,
            "instrument_token": order.instrument_token,
            "quantity": order.transaction_type == 'SELL' ? -1 * order.quantity : order.quantity,
            "average_price": order.average_price,
            "last_price": order.average_price,
            "m2m": 0,
            "sell_quantity": 0,
            "sell_price": 0,
            "sell_value": 0,
            "buy_quantity": 0,
            "buy_price": 0,
            "buy_value": 0
        };

        position[(order.transaction_type).toLowerCase() + "_quantity"] = order.quantity;
        position[(order.transaction_type).toLowerCase() + "_price"] = order.average_price;
        position[(order.transaction_type).toLowerCase() + "_value"] = order.average_price * order.quantity;
    }

    if (position.quantity == 0) {
        position.m2m = position.sell_value - position.buy_value;
    }

    return position;
}

const positionsBuilder = function (orders, position_cache = {}) {
    if (orders.length === 0) {
        return position_cache;
    }

    if (position_cache.length === 0) {
        positions
    }

    return position_cache;
}

const openPositionBuilder = function (orders) {
}

module.exports = {
    positionsBuilder,
    openPositionBuilder
};
