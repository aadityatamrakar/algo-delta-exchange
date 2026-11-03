const moment = require('moment');

module.exports = function (strategyTag = 'Lion') {
  if (strategyTag == 'Lion') {
    if (moment().day() == 1) {
      return 0;
    } else if (moment().day() == 2) {
      return 0;
    } else if (moment().day() == 4) {
      return 0;
    } else if (moment().day() == 5) {
      return 0;
    } else return 0;
  } else if (strategyTag == 'Lion_SNX') {
    if (moment().day() == 1) {
      return 0;
    } else if (moment().day() == 2) {
      return 0;
    } else if (moment().day() == 3) {
      return 0;
    } else if (moment().day() == 4) {
      return 0;
    } else return 0;
  } else if (strategyTag == 'Cheetah') {
    if (moment().day() == 1) {
      return 0;
    } else if (moment().day() == 2) {
      return 0;
    } else if (moment().day() == 4) {
      return 0;
    } else if (moment().day() == 5) {
      return 0;
    } else return 0;
  } else if (strategyTag == 'SD_2') {
    if (moment().day() == 1) {
      return [5, 3, 4, 18, -5, -10];
    } else if (moment().day() == 2) {
      return [5, 3, 4, 18, -5, -10];
    } else if (moment().day() == 3) {
      return [5, 3, 4, 18, -5, -10];
    } else if (moment().day() == 3) {
      return [5, 3, 4, 18, -5, -10];
    } else if (moment().day() == 5) {
      return [5, 3, 4, 18, -5, -10];
    }
  } else if (strategyTag == 'SD_3') {
    if (moment().day() == 1) {
      return [5, 3, 7, 18, -5, -10];
    } else if (moment().day() == 2) {
      return [5, 3, 7, 18, -5, -10];
    } else if (moment().day() == 3) {
      return [5, 3, 7, 18, -5, -10];
    } else if (moment().day() == 3) {
      return [5, 3, 7, 18, -5, -10];
    } else if (moment().day() == 5) {
      return [5, 3, 7, 18, -5, -10];
    }
  }

}
