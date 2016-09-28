define([
	"jquery",
	"underscore",
	"core",
	"utils",
	"storage",
	"logger",
	"constants",
	"settings",
	"eventMgr",
	"classes/AsyncTask"
], function($, _, core, utils, storage, logger, constants, settings, eventMgr, AsyncTask) {

	var couchdbHelper = {};

	// Listen to offline status changes
	var isOffline = false;
	eventMgr.addListener("onOfflineChanged", function(isOfflineParam) {
		isOffline = isOfflineParam;
	});

	couchdbHelper.couchdbUrl = function(url) {
		var anchor = document.createElement('a');
		anchor.href = url;
		return anchor.protocol + '//' + anchor.host + anchor.pathname + anchor.search
	};

	couchdbHelper.startSession = function() {
		var task = new AsyncTask();
		var anchor = document.createElement('a');
		anchor.href = settings.couchdbUrl;
		if (anchor.username === '') {
			return task; // No credentials provided; no session to start
		}

		task.onRun(function() {
			$.ajax({
				type: 'POST',
				url: couchdbHelper.couchdbUrl(settings.couchdbUrl) + '/../_session',
				contentType: 'application/json',
				xhrFields: {
					withCredentials: true
				},
				dataType: 'json',
				data: JSON.stringify({
					name: anchor.username,
					password: anchor.password
				})
			}).done(function(data, status, jqXHR) {
				if (data.ok !== true) {
					handleError(jqXHR, task);
					return;
				}
				task.chain();
			}).fail(function(jqXHR) {
				handleError(jqXHR, task);
			});
		});
		return task;
	};

	couchdbHelper.uploadDocument = function(documentId, title, content, tags, rev, callback) {
		var result;
		var task = this.startSession();
		task.onRun(function() {
			if(tags) {
				// Has to be an array
				if(!_.isArray(tags)) {
					tags = _.chain(('' + tags).split(/,/))
						.compact()
						.unique()
						.value();
				}
				// Remove invalid tags
				tags = tags.filter(function(tag) {
					return _.isString(tag) && tag.length < 32;
				});
				// Limit the number of tags
				tags = tags.slice(0, 16);
			}
			else {
				tags = undefined;
			}
			$.ajax({
				type: 'POST',
				url: couchdbHelper.couchdbUrl(settings.couchdbUrl),
				contentType: 'application/json',
				xhrFields: {
					withCredentials: true
				},
				dataType: 'json',
				data: JSON.stringify({
					_id: documentId || utils.id(),
					title: title,
					tags: tags,
					updated: Date.now(),
					_rev: rev,
					_attachments: {
						content: {
							content_type: 'text\/plain',
							data: utils.encodeBase64(content)
						}
					}
				})
			}).done(function(data) {
				result = data;
				task.chain();
			}).fail(function(jqXHR) {
				handleError(jqXHR, task);
			});
		});
		task.onSuccess(function() {
			callback(undefined, result);
		});
		task.onError(function(error) {
			callback(error);
		});
		task.enqueue();
	};

	couchdbHelper.checkChanges = function(lastChangeId, syncLocations, callback) {
		var changes;
		var newChangeId = lastChangeId || 0;
		var task = this.startSession();
		task.onRun(function() {
			$.ajax({
				type: 'POST',
				url: couchdbHelper.couchdbUrl(settings.couchdbUrl) + '/_changes?' + $.param({
					filter: '_doc_ids',
					since: newChangeId,
					include_docs: true,
					attachments: true
				}),
				contentType: 'application/json',
				xhrFields: {
					withCredentials: true
				},
				dataType: 'json',
				data: JSON.stringify({
					doc_ids: Object.keys(syncLocations)
				})
			}).done(function(data) {
				newChangeId = data.last_seq;
				changes = _.map(data.results, function(result) {
					return result.deleted ? {
						_id: result.id,
						deleted: true
					} : result.doc;
				});
				task.chain();
			}).fail(function(jqXHR) {
				handleError(jqXHR, task);
			});
		});
		task.onSuccess(function() {
			callback(undefined, changes, newChangeId);
		});
		task.onError(function(error) {
			callback(error);
		});
		task.enqueue();
	};

	couchdbHelper.downloadContent = function(documents, callback) {
		var result = [];
		var task = this.startSession();
		task.onRun(function() {
			function recursiveDownloadContent() {
				if(documents.length === 0) {
					return task.chain();
				}
				var document = documents[0];
				result.push(document);
				if(document.deleted || ((document._attachments || {}).content || {}).data !== undefined) {
					documents.shift();
					return task.chain(recursiveDownloadContent);
				}
				$.ajax({
					url: couchdbHelper.couchdbUrl(settings.couchdbUrl) + '/' + encodeURIComponent(document._id),
					headers: {
						Accept: 'application/json'
					},
					contentType: 'application/json',
					xhrFields: {
						withCredentials: true
					},
					dataType: 'json',
					data: {
						attachments: true
					}
				}).done(function(doc) {
					documents.shift();
					_.extend(document, doc);
					task.chain(recursiveDownloadContent);
				}).fail(function(jqXHR) {
					handleError(jqXHR, task);
				});
			}

			task.chain(recursiveDownloadContent);
		});
		task.onSuccess(function() {
			callback(undefined, result);
		});
		task.onError(function(error) {
			callback(error);
		});
		task.enqueue();
	};

	couchdbHelper.listDocuments = function(tag, updated, callback) {
		var result;
		var task = this.startSession();
		task.onRun(function() {
			var ddoc = '/_design/by_' + (tag ? 'tag_and_' : '') + 'update/_view/default';
			var startKey = tag ? JSON.stringify([
				tag,
				updated || []
			]) : updated;
			var endKey = tag ? JSON.stringify([
				tag
			]) : undefined;
			$.ajax({
				type: 'GET',
				url: couchdbHelper.couchdbUrl(settings.couchdbUrl) + ddoc,
				contentType: 'application/json',
				xhrFields: {
					withCredentials: true
				},
				crossDomain: true,
				dataType: 'json',
				data: {
					start_key: startKey,
					end_key: endKey,
					descending: true,
					include_docs: true,
					limit: constants.COUCHDB_PAGE_SIZE,
					reduce: false
				}
			}).done(function(data) {
				result = _.pluck(data.rows, 'doc');
				task.chain();
			}).fail(function(jqXHR) {
				handleError(jqXHR, task);
			});
		});
		task.onSuccess(function() {
			callback(undefined, result);
		});
		task.onError(function(error) {
			callback(error);
		});
		task.enqueue();
	};

	couchdbHelper.deleteDocuments = function(docs) {
		var task = this.startSession();
		task.onRun(function() {
			$.ajax({
				type: 'POST',
				url: couchdbHelper.couchdbUrl(settings.couchdbUrl) + '/_bulk_docs',
				contentType: 'application/json',
				xhrFields: {
					withCredentials: true
				},
				dataType: 'json',
				data: JSON.stringify({
					docs: docs.map(function(doc) {
						return {
							_id: doc._id,
							_rev: doc._rev,
							_deleted: true
						};
					})
				}),
			}).done(function() {
				task.chain();
			}).fail(function(jqXHR) {
				handleError(jqXHR, task);
			});
		});
		task.enqueue();
	};

	function handleError(jqXHR, task) {
		var error = {
			code: jqXHR.status,
			message: jqXHR.statusText,
			reason: (jqXHR.responseJSON || {}).reason
		};
		var errorMsg;
		if(error) {
			logger.error(error);
			// Try to analyze the error
			if(typeof error === "string") {
				errorMsg = error;
			}
			else {
				errorMsg = "Error " + error.code + ": " + (error.reason || error.message);
			}
		}
		task.error(new Error(errorMsg));
	}

	return couchdbHelper;
});
