const AWS = require('aws-sdk');
const fs = require('fs');
const uuidv4 = require('uuid/v4');

const s3 = new AWS.S3({
	accessKeyId: 'AKIAIJ4RE6PGQWTUIWHQ',
	secretAccessKey: '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'
});

const uploadFile = (fileName, content, public, key, BUCKET_NAME) => {
	return new Promise((resolve, reject) => {
		const fileContent = fs.readFileSync(fileName);
		const params = {
			Bucket: BUCKET_NAME,
			Key: key,
			Body: fileContent,
			ContentType: content
		};

		if (public) params.ACL = 'public-read';
		
		s3.upload(params, function (err, data) {
			if (err) {
				console.log(err);
				resolve(false);
			}
			resolve(data);
		});
	})
};

module.exports = uploadFile;
