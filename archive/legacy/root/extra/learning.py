from sklearn import preprocessing
import time
import math
import pickle
import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
from sklearn.metrics import mean_squared_error
from sklearn.metrics import r2_score

from sklearn.neighbors import KNeighborsClassifier
from sklearn.svm import SVC
from sklearn.ensemble import RandomForestClassifier

start = time.time()
df = pd.read_csv('training.txt')
# df2 = pd.read_csv('training2.txt')
data = df.dropna(axis = 0, how ='any')
# data2 = df2.dropna(axis = 0, how ='any')
data = df.as_matrix()
# data2 = df2.as_matrix()

X = data[0:, :-1]
y = data[0:, -1:]
y = y.astype('int')
# X2 = data2[0:, :-1]
# y2 = data2[0:, -1:]
# y2 = y2.astype('int')

print(np.shape(X), np.shape(y))
# print(np.shape(X2), np.shape(y2))
# print('is nan: ', np.where(np.isnan(X)))

# clf = KNeighborsClassifier(n_neighbors=3, n_jobs=-1)
# clf = RandomForestClassifier()
clf = SVC(kernel='rbf')
clf.fit(X, y)

# y2_pred = clf.predict(X2)
# print('MAE: ', mean_absolute_error(y2, y2_pred))
# print('RMSE: ', math.sqrt(mean_squared_error(y2, y2_pred)))
# print('Score: ', clf.score(X2, y2))
# pickle.dump(clf, open('models/clf.sav', 'wb'))

import matplotlib.pyplot as plt
ax = plt.subplot()
ax.scatter(X[0:, 0:1], X[0:, 1:], c=y, alpha=0.3, edgecolors='none')
ax.legend()
ax.grid(True)
plt.show()

# from sklearn_porter import Porter
# porter = Porter(clf, language='js')
# output = porter.export(embed_data=True)
# print(output)

end = time.time()
print("Total Time: ", (end-start))