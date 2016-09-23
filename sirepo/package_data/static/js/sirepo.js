'use strict';
SIREPO.srlog = console.log.bind(console);
SIREPO.srdbg = console.log.bind(console);

// No timeout for now (https://github.com/radiasoft/sirepo/issues/317)
SIREPO.http_timeout = 0;

var srlog = SIREPO.srlog;
var srdbg = SIREPO.srdbg;

// start the angular app after the app's json schema file has been loaded
angular.element(document).ready(function() {
    $.ajax({
        url: '/simulation-schema?' + SIREPO.APP_VERSION,
        data: {
            simulationType: SIREPO.APP_NAME,
        },
        success: function(result) {
            SIREPO.APP_SCHEMA = result;
            angular.bootstrap(document, ['SirepoApp']);
        },
        error: function(xhr, status, err) {
            if (! SIREPO.APP_SCHEMA)
                srlog("schema load failed: ", err);
        },
        method: 'POST',
        dataType: 'json',
    });
});

SIREPO.appLocalRoutes = {
    simulations: '/simulations',
    source: '/source/:simulationId',
    notFound: '/not-found',
    notFoundCopy: '/copy-session/:simulationIds',
};

SIREPO.appDefaultSimulationValues = {
    simulation: {},
    simulationFolder: {},
};

angular.module('log-broadcasts', []).config(['$provide', function ($provide) {
    $provide.decorator('$rootScope', function ($delegate) {
        var _emit = $delegate.$emit;
        var _broadcast = $delegate.$broadcast;

        $delegate.$emit = function () {
            return _emit.apply(this, arguments);
        };

        $delegate.$broadcast = function () {
            return _broadcast.apply(this, arguments);
        };

        return $delegate;
    });
}]);

// Add "log-broadcasts" in dependencies if you want to see all broadcasts
SIREPO.app = angular.module('SirepoApp', ['ngDraggable', 'ngRoute', 'd3', 'shagstrom.angular-split-pane', 'underscore']);

SIREPO.app.value('localRoutes', SIREPO.appLocalRoutes);

SIREPO.app.config(function($routeProvider, localRoutesProvider) {
    var localRoutes = localRoutesProvider.$get();
    $routeProvider
        .when(localRoutes.simulations, {
            controller: 'SimulationsController as simulations',
            templateUrl: '/static/html/simulations.html?' + SIREPO.APP_VERSION,
        })
        .when(localRoutes.notFound, {
            templateUrl: '/static/html/not-found.html?' + SIREPO.APP_VERSION,
        })
        .when(localRoutes.notFoundCopy, {
            controller: 'NotFoundCopyController as notFoundCopy',
            templateUrl: '/static/html/copy-session.html?' + SIREPO.APP_VERSION,
        })
        .otherwise({
            redirectTo: localRoutes.simulations,
        });
});

SIREPO.app.factory('activeSection', function($route, $rootScope, $location, appState) {
    var self = this;

    self.getActiveSection = function() {
        var match = ($location.path() || '').match(/^\/([^\/]+)/);
        return match
            ? match[1]
            : null;
    };

    $rootScope.$on('$routeChangeSuccess', function() {
        if ($route.current.params.simulationId)
            appState.loadModels($route.current.params.simulationId);
    });

    return self;
});

SIREPO.app.factory('appState', function(requestSender, requestQueue, $rootScope, $interval, _) {
    var self = {
        models: {},
    };
    var QUEUE_NAME = 'saveSimulationData';
    var lastAutoSaveData = null;
    var autoSaveTimer = null;
    var savedModelValues = {};
    var activeFolderPath = null;
    var alertText = null;

    function broadcastClear() {
        $rootScope.$broadcast('clearCache');
    }

    function broadcastChanged(name) {
        $rootScope.$broadcast(name + '.changed');
        $rootScope.$broadcast('modelChanged', name);
    }

    function broadcastLoaded() {
        $rootScope.$broadcast('modelsLoaded');
    }

    function updateReports() {
        broadcastClear();
        for (var key in self.models) {
            if (self.isReportModelName(key))
                broadcastChanged(key);
        }
    }

    self.alertText = function(value) {
        if (angular.isDefined(value)) {
            alertText = value;
        }
        return alertText;
    };

    self.applicationState = function() {
        return savedModelValues;
    };

    self.autoSave = function(callback) {
        if (! self.isLoaded() ||
            lastAutoSaveData && self.deepEquals(lastAutoSaveData.models, savedModelValues)
        ) {
            // no changes
            if ($.isFunction(callback)) {
                callback({'state': 'noChanges'});
            }
            return;
        }
        requestQueue.addItem(
            QUEUE_NAME,
            function() {
                self.resetAutoSaveTimer();
                lastAutoSaveData.models = self.clone(savedModelValues);
                return {
                    urlOrParams: 'saveSimulationData',
                    successCallback: function (resp) {
                        if (resp.error && resp.error == 'invalidSerial') {
                            srlog(resp.simulationData.models.simulation.simulationId, ': update collision newSerial=', resp.simulationData.models.simulation.simulationSerial, '; refreshing');
                            self.refreshSimulationData(resp.simulationData);
                            self.alertText('Another browser updated this simulation; local state has been refreshed');
                        }
                        else {
                            lastAutoSaveData = self.clone(resp);
                            savedModelValues.simulation.simulationSerial
                                = lastAutoSaveData.models.simulation.simulationSerial;
                            self.models.simulation.simulationSerial
                                = lastAutoSaveData.models.simulation.simulationSerial;
                        }
                        if ($.isFunction(callback)) {
                            callback(resp);
                        }
                    },
                    errorCallback: function (resp, status) {
                        if ($.isFunction(callback)) {
                            //TODO(robnagler) this should be errorCallback
                            callback(resp);
                        }
                    },
                    data: lastAutoSaveData
                };
            }
        );
    };
    self.cancelChanges = function(name) {
        // cancel changes on a model by name, or by an array of names
        if (typeof(name) == 'string')
            name = [name];

        for (var i = 0; i < name.length; i++) {
            if (savedModelValues[name[i]])
                self.models[name[i]] = self.clone(savedModelValues[name[i]]);
            $rootScope.$broadcast('cancelChanges', name[i]);
        }
    };

    self.clearModels = function(emptyValues) {
        requestQueue.cancelItems(QUEUE_NAME);
        broadcastClear();
        self.models = emptyValues || {};
        savedModelValues = self.clone(self.models);
        if (autoSaveTimer)
            $interval.cancel(autoSaveTimer);
    };

    self.clone = function(obj) {
        return angular.copy(obj);
    };

    self.cloneModel = function(name) {
        var val = name ? self.models[name] : self.models;
        return self.clone(val);
    };

    self.copySimulation = function(simulationId, op, name) {
        requestSender.sendRequest(
            'copySimulation',
            op,
            {
                simulationId: simulationId,
                simulationType: SIREPO.APP_SCHEMA.simulationType,
                name: name,
            });
    };

    self.deepEquals = function(v1, v2) {
        if (angular.isArray(v1) && angular.isArray(v2)) {
            if (v1.length != v2.length)
                return false;
            for (var i = 0; i < v1.length; i++) {
                if (! self.deepEquals(v1[i], v2[i]))
                    return false;
            }
            return true;
        }
        if (angular.isObject(v1) && angular.isObject(v2)) {
            var keys = Object.keys(v1);
            if (keys.length != Object.keys(v2).length)
                return false;
            var isEqual = true;
            keys.forEach(function (k) {
                if (! self.deepEquals(v1[k], v2[k]))
                    isEqual = false;
            });
            return isEqual;
        }
        return v1 == v2;
    };

    self.deleteSimulation = function(simulationId, op) {
        requestSender.sendRequest(
            'deleteSimulation',
            op,
            {
                simulationId: simulationId,
                simulationType: SIREPO.APP_SCHEMA.simulationType,
            });
    };

    self.getActiveFolderPath = function() {
        return activeFolderPath;
    };

    self.isAnimationModelName = function(name) {
        return name == 'animation' || name.indexOf('Animation') >= 0;
    };

    self.isLoaded = function() {
        return self.models.simulation && self.models.simulation.simulationId ? true: false;
    };

    self.isReportModelName = function(name) {
        //TODO(pjm): need better name for this, a model which doesn't affect other models
        return  name.indexOf('Report') >= 0 || self.isAnimationModelName(name) || name.indexOf('Status') >= 0;
    };

    self.listSimulations = function(search, op) {
        requestSender.sendRequest(
            'listSimulations',
            op,
            {
                simulationType: SIREPO.APP_SCHEMA.simulationType,
                search: search,
            });
    };

    self.loadModels = function(simulationId, callback) {
        if (self.isLoaded() && self.models.simulation.simulationId == simulationId)
            return;
        self.clearModels();
        requestSender.sendRequest(
            {
                routeName: 'simulationData',
                '<simulation_id>': simulationId,
                '<simulation_type>': SIREPO.APP_SCHEMA.simulationType,
                '<pretty>': false
            },
            function(data, status) {
                if (data.redirect) {
                    requestSender.localRedirect('notFoundCopy', {
                        ':simulationIds': data.redirect.simulationId
                            + (data.redirect.userCopySimulationId
                               ? ('-' + data.redirect.userCopySimulationId)
                               : ''),
                    });
                    return;
                }
                self.refreshSimulationData(data);
                if (callback)
                    callback();
            }
        );
    };

    self.maxId = function(items, idField) {
        var max = 1;
        if (! idField)
            idField = 'id';
        for (var i = 0; i < items.length; i++) {
            if (items[i][idField] > max)
                max = items[i][idField];
        }
        return max;
    };

    self.modelInfo = function(name) {
        return SIREPO.APP_SCHEMA.model[name];
    };

    self.newSimulation = function(model, op) {
        requestSender.sendRequest(
            'newSimulation',
            op,
            {
                name: model.name,
                folder: model.folder,
                sourceType: model.sourceType,
                simulationType: SIREPO.APP_SCHEMA.simulationType,
            });
    };

    self.parseModelField = function(name) {
        // returns [model, field] from a "model.field" name
        var match = name.match(/(.*?)\.(.*)/);
        if (match)
            return [match[1], match[2]];
        return null;
    };

    self.removeModel = function(name) {
        delete self.models[name];
        delete savedModelValues[name];
    };

    self.resetAutoSaveTimer = function() {
        // auto save data every 60 seconds
        if (autoSaveTimer)
            $interval.cancel(autoSaveTimer);
        autoSaveTimer = $interval(self.autoSave, 60000);
    };

    self.saveQuietly = function(name) {
        // saves the model, but doesn't broadcast the change
        savedModelValues[name] = self.cloneModel(name);
    };

    self.saveChanges = function(name) {
        // save changes on a model by name, or by an array of names
        if (typeof(name) == 'string')
            name = [name];
        var updatedModels = [];
        var requireReportUpdate = false;

        for (var i = 0; i < name.length; i++) {
            if (self.deepEquals(savedModelValues[name[i]], self.models[name[i]])) {
                // let the UI know the primary model has changed, even if it hasn't
                if (i === 0)
                    updatedModels.push(name[i]);
            }
            else {
                self.saveQuietly(name[i]);
                updatedModels.push(name[i]);
                if (! self.isReportModelName(name[i]))
                    requireReportUpdate = true;
            }
        }

        self.autoSave(function() {
            for (i = 0; i < updatedModels.length; i++) {
                if (requireReportUpdate && self.isReportModelName(updatedModels[i]))
                    continue;
                broadcastChanged(updatedModels[i]);
            }

            if (requireReportUpdate)
                updateReports();
        });
    };

    self.refreshSimulationData = function(data, callback) {
        self.models = data.models;
        self.models.simulationStatus = {};
        savedModelValues = self.cloneModel();
        lastAutoSaveData = self.clone(data);
        updateReports();
        broadcastLoaded();
        self.resetAutoSaveTimer();
        if (callback)
            callback();
    };

    self.setActiveFolderPath = function(path) {
        activeFolderPath = path;
    };

    self.viewInfo = function(name) {
        return SIREPO.APP_SCHEMA.view[name];
    };

    self.whenModelsLoaded = function($scope, callback) {
        if (self.isLoaded())
            callback();
        else
            $scope.$on('modelsLoaded', callback);
    };

    return self;
});

SIREPO.app.factory('frameCache', function(appState, panelState, requestSender, $interval, $rootScope) {
    var self = {};
    var frameCountByModelKey = {};
    var masterFrameCount = 0;
    self.animationInfo = {};


    function animationArgs(modelName) {
        var values = appState.applicationState()[modelName];
        var fields = self.animationArgFields[modelName];
        var args = [];
        for (var i = 0; i < fields.length; i++)
            args.push(values[fields[i]]);
        return args.join('_');
    }

    self.clearFrames = function(modelName) {
        // TODO(robnagler) if there are locally cached frames, they
        // would be cleared here, but right now they are in the browser
        // cache so do nothing.
        return;
    };

    self.getCurrentFrame = function(modelName) {
        var v = self.animationInfo[modelName];
        if (v)
            return v.currentFrame;
        return 0;
    };

    self.getFrame = function(modelName, index, isPlaying, callback) {
        if (! appState.isLoaded())
            return;
        var isHidden = panelState.isHidden(modelName);
        //TODO(robnagler) why doesn't this come from the server?
        var startTime = new Date().getTime();
        var delay = isPlaying && ! isHidden
            ? 1000 / parseInt(appState.models[modelName].framesPerSecond)
            : 0;
        var frameId = [
            SIREPO.APP_SCHEMA.simulationType,
            appState.models.simulation.simulationId,
            modelName,
            animationArgs(modelName),
            index,
            //TODO(robnagler) startTime should be reportParametersHash
            appState.models.simulationStatus[self.animationModelName || modelName].startTime,
        ].join('*');
        var requestFunction = function() {
            requestSender.sendRequest(
                {
                    'routeName': 'simulationFrame',
                    '<frame_id>': frameId,
                },
                function(data) {
                    var endTime = new Date().getTime();
                    var elapsed = endTime - startTime;
                    if (elapsed < delay)
                        $interval(
                            function() {
                                callback(index, data);
                            },
                            delay - elapsed,
                            1
                        );
                    else
                        callback(index, data);
                });
        };
        if (isHidden)
            panelState.addPendingRequest(modelName, requestFunction);
        else
            requestFunction();
    };

    self.isLoaded = function() {
        return appState.isLoaded();
    };

    self.getFrameCount = function(modelKey) {
        if (modelKey in frameCountByModelKey)
            return frameCountByModelKey[modelKey];
        return masterFrameCount;
    };

    self.setAnimationArgs = function(argFields, animationModelName) {
        self.animationArgFields = argFields;
        if (animationModelName)
            self.animationModelName = animationModelName;
    };

    self.setCurrentFrame = function(modelName, currentFrame) {
        if (! self.animationInfo[modelName])
            self.animationInfo[modelName] = {};
        self.animationInfo[modelName].currentFrame = currentFrame;
    };

    self.setFrameCount = function(frameCount, modelKey) {
        if (modelKey) {
            frameCountByModelKey[modelKey] = frameCount;
            return;
        }
        if (frameCount == masterFrameCount)
            return;
        if (frameCount === 0) {
            masterFrameCount = frameCount;
            frameCountByModelKey = {};
            $rootScope.$broadcast('framesCleared');
        }
        else if (frameCount > 0) {
            var oldFrameCount = masterFrameCount;
            masterFrameCount = frameCount;
            $rootScope.$broadcast('framesLoaded', oldFrameCount);
        }
        else {
            masterFrameCount = frameCount;
        }
    };

    return self;
});

SIREPO.app.factory('panelState', function(appState, simulationQueue, $compile, $rootScope, $timeout, $window) {
    // Tracks the data, error, hidden and loading values
    var self = {};
    var panels = {};
    var pendingRequests = {};
    $rootScope.$on('clearCache', function() {
        self.clear();
    });

    function clearPanel(name) {
        delete panels[name];
        delete pendingRequests[name];
    }

    function getPanelValue(name, key) {
        if (panels[name] && panels[name][key])
            return panels[name][key];
        return null;
    }

    function sendRequest(name, callback, forceRun) {
        setPanelValue(name, 'loading', true);
        setPanelValue(name, 'error', null);
        var responseHandler = function(resp) {
            setPanelValue(name, 'loading', false);
            if (resp.error) {
                setPanelValue(name, 'error', resp.error);
            }
            else {
                setPanelValue(name, 'data', resp);
                setPanelValue(name, 'error', null);
                callback(resp);
            }
        };
        simulationQueue.addTransientItem(
            name,
            appState.applicationState(),
            responseHandler,
            forceRun
        );
    }

    function setPanelValue(name, key, value) {
        if (! (name || key))
            throw 'missing name or key';
        if (! panels[name])
            panels[name] = {};
        panels[name][key] = value;
    }

    self.addPendingRequest = function(name, requestFunction) {
        pendingRequests[name] = requestFunction;
    };

    self.clear = function(name) {
        if (name)
            clearPanel(name);
        else {
            for (name in panels)
                clearPanel(name);
        }
    };

    self.getError = function(name) {
        return getPanelValue(name, 'error');
    };

    self.isHidden = function(name) {
        if (! appState.isLoaded())
            return true;
        var state = appState.applicationState();
        if (state.panelState)
            return state.panelState.hidden.indexOf(name) >= 0;
        return false;
    };

    self.isLoading = function(name) {
        return getPanelValue(name, 'loading') ? true : false;
    };

    self.requestData = function(name, callback, forceRun) {
        if (! appState.isLoaded())
            return;
        var data = getPanelValue(name, 'data');
        if (data) {
            callback(data);
            return;
        }
        if (self.isHidden(name)) {
            self.addPendingRequest(name, function() {
                sendRequest(name, callback, forceRun);
            });
        }
        else
            sendRequest(name, callback, forceRun);
    };

    self.setError = function(name, error) {
        setPanelValue(name, 'error', error);
    };

    self.showModalEditor = function(modelKey, template, scope) {
        var editorId = '#s-' + modelKey + '-editor';

        if ($(editorId).length)
            $(editorId).modal('show');
        else {
            if (! template)
                template = '<div data-modal-editor="" data-view-name="' + modelKey + '"></div>';
            $('body').append($compile(template)(scope || $rootScope));
            //TODO(pjm): timeout hack, other jquery can't find the element
            $timeout(function() {
                $(editorId).modal('show');
            });
        }
    };

    self.toggleHidden = function(name) {
        var state = appState.applicationState();
        if (! state.panelState) {
            state.panelState = {
                hidden: [],
            };
        }
        if (self.isHidden(name)) {
            state.panelState.hidden.splice(state.panelState.hidden.indexOf(name), 1);

            if (pendingRequests[name]) {
                var requestFunction = pendingRequests[name];
                delete pendingRequests[name];
                requestFunction();
            }
            // needed to resize a hidden report
            if (appState.isReportModelName(name))
                $($window).trigger('resize');
        }
        else
            state.panelState.hidden.push(name);
    };

    return self;
});

SIREPO.app.factory('requestSender', function(localRoutes, $http, $location, $interval, $q, _, exceptionLoggingService) {
    var self = {};
    var getApplicationDataTimeout;
    var IS_HTML_ERROR_RE = new RegExp('<!DOCTYPE', 'i');

    function logError(data, status) {
        srlog('request failed: ', data);
        if (status == 404)
            self.localRedirect('notFound');
    }

    function formatUrl(map, routeOrParams, params) {
        var routeName = routeOrParams;
        if (angular.isObject(routeOrParams)) {
            routeName = routeOrParams.routeName;
            if (! routeName)
                throw routeOrParams + ': routeName must be supplied';
            if (angular.isDefined(params)) {
                srlog(arguments);
                throw params + ': params must be null if routeOrParams is an object: ' + routeOrParams;
            }
            params = angular.copy(routeOrParams);
            delete params.routeName;
        }
        if (! map[routeName])
            throw routeName + ': routeName not found';
        var url = map[routeName];
        if (params) {
            for (var k in params) {
                if (url.indexOf(k) < 0)
                    throw k + ': param not found in route: ' + map[routeName];
                url = url.replace(
                    k,
                    encodeURIComponent(serializeValue(params[k], k)));
            }
        }
        var missing = url.match(/<[^>]+>/g);
        if (missing)
            throw missing.join() + ': missing parameter(s) for route: ' + map[routeName];
        return url;
    }

    // Started from serializeValue in angular, but need more specialization.
    // https://github.com/angular/angular.js/blob/2420a0a77e27b530dbb8c41319b2995eccf76791/src/ng/http.js#L12
    function serializeValue(v, param) {
        if (v === null)
            throw param + ': may not be null';
        if (typeof v == 'boolean')
            //TODO(robnagler) probably needs to be true/false with test
            return v ? '1' : '0';
        if (angular.isString(v)) {
            if (v === '')
                throw param + ': may not be empty string';
            return v;
        }
        if (angular.isNumber(v))
            return v.toString();
        if (angular.isDate(v))
            return v.toISOString();
        throw param + ': ' + (typeof v) + ' type cannot be serialized';
    }

    self.formatUrlLocal = function(routeName, params) {
        return formatUrl(localRoutes, routeName, params);
    };

    self.formatUrl = function(routeName, params) {
        return formatUrl(SIREPO.APP_SCHEMA.route, routeName, params);
    };

    self.getApplicationData = function(data, callback) {
        // debounce the method so server calls don't go on every keystroke
        if (getApplicationDataTimeout)
            $interval.cancel(getApplicationDataTimeout);
        getApplicationDataTimeout = $interval(function() {
            getApplicationDataTimeout = null;
            data.simulationType = SIREPO.APP_SCHEMA.simulationType;
            self.sendRequest('getApplicationData', callback, data);
        }, 350, 1);
    };

    self.getAuxiliaryData = function(name) {
        return self[name];
    };

    self.isRouteParameter = function(routeName, paramName) {
        return (localRoutes[routeName] || SIREPO.APP_SCHEMA.route[routeName]).indexOf(paramName) >= 0;
    };

    self.loadAuxiliaryData = function(name, path, callback) {
        if (self[name] || self[name + ".loading"]) {
            if (callback)
                callback(self[name]);
            return;
        }
        self[name + ".loading"] = true;
        $http.get(path + '?' + SIREPO.APP_VERSION)
            .success(function(data, status) {
                self[name] = data;
                delete self[name + ".loading"];
                if (callback)
                    callback(data);
            })
            .error(function() {
                srlog(path, ' load failed!');
                delete self[name + ".loading"];
            });
    };

    self.localRedirect = function(routeName, params, search) {
        $location.path(self.formatUrlLocal(routeName, params));
        if (search)
            $location.search(search);
    };

    self.sendRequest = function(urlOrParams, successCallback, data, errorCallback) {
        if (! errorCallback)
            errorCallback = logError;
        if (! successCallback)
            successCallback = function () {};
        var url = angular.isString(urlOrParams) && urlOrParams.indexOf('/') >= 0
            ? urlOrParams
            : self.formatUrl(urlOrParams);
        var timeout = $q.defer();
        var interval, t;
        var timed_out = false;
        t = {timeout: timeout.promise};
        if (SIREPO.http_timeout > 0) {
            interval = $interval(
                function () {
                    timed_out = true;
                    timeout.resolve();
                },
                SIREPO.http_timeout,
                1
            );
        }
        var req = data
            ? $http.post(url, data, t)
            : $http.get(url, t);
        req.success(
            function(resp, status) {
                $interval.cancel(interval);
                successCallback(resp, status);
            }
        );
        req.error(
            function(resp, status) {
                $interval.cancel(interval);
                var msg = null;
                if (timed_out) {
                    msg = 'request timed out after '
                        + Math.round(SIREPO.http_timeout/1000)
                        + ' seconds';
                    status = 503;
                }
                else if (status === 0) {
                    msg = 'the server is unavailable';
                }
                if (_.isString(resp) && IS_HTML_ERROR_RE.exec(resp)) {
                    srlog('ERROR: unexpected HTML response: ', resp);
                    resp = {};
                }
                else if (! _.isObject(resp) || _.isEmpty(resp)) {
                    exceptionLoggingService(resp, 'unexpected response type or empty');
                    resp = {};
                }
                if (! resp.state) {
                    resp.state = 'error';
                }
                if (! resp.error) {
                    resp.error = msg || 'a server error occured: status=' + status;
                }
                errorCallback(resp, status);
            }
        );
    };

    return self;
});

SIREPO.app.factory('simulationQueue', function($rootScope, $interval, requestSender, exceptionLoggingService) {
    var self = {};
    var runQueue = [];

    function addItem(report, models, responseHandler, qMode, forceRun) {
        models = angular.copy(models);
        // Not used server side and contains a lot of stuff
        delete models.simulationStatus;
        var qi = {
            firstRoute: qMode == 'persistentStatus' ? 'runStatus' : 'runSimulation',
            qMode: qMode,
            persistent: qMode.indexOf('persistent') > -1,
            qState: 'pending',
            request: {
                forceRun: qMode == 'persistent' || forceRun ? true : false,
                report: report,
                models: models,
                simulationType: SIREPO.APP_SCHEMA.simulationType,
                simulationId: models.simulation.simulationId,
            },
            responseHandler: responseHandler,
        };
        runQueue.push(qi);
        if (qi.persistent)
            runItem(qi);
        else
            runFirstTransientItem();
        return qi;
    }

    function cancelInterval(qi) {
        if (! qi.interval)
            return;
        $interval.cancel(qi.interval);
        qi.interval = null;
    }

    function handleResult(qi, resp) {
        qi.qState = 'done';
        self.removeItem(qi);
        qi.responseHandler(resp);
        runFirstTransientItem();
    }

    function runFirstTransientItem() {
        $.each(
            runQueue,
            function(i, e) {
                if (e.persistent)
                    return true;
                if (e.qState == 'pending')
                    runItem(e);
                return false;
            }
        );
    }

    function runItem(qi) {
        var handleStatus = function(qi, resp) {
            qi.request = resp.nextRequest;
            qi.interval = $interval(
                function () {
                    requestSender.sendRequest(
                        'runStatus', process, qi.request, process);
                },
                // Sanity check in case of defect on server
                Math.max(1, resp.nextRequestSeconds) * 1000,
                1
            );
            if (qi.persistent)
                qi.responseHandler(resp);
        };

        var process = function(resp, status) {
            if (qi.qState == 'removing')
                return;
            resp.isStateProcessing = resp.state == 'running' || resp.state == 'pending';
            if (! resp.isStateProcessing) {
                handleResult(qi, resp);
                return;
            }
            handleStatus(qi, resp);
        };

        cancelInterval(qi);
        qi.qState = 'processing';
        requestSender.sendRequest(qi.firstRoute, process, qi.request, process);
    }

    self.addPersistentStatusItem = function(report, models, responseHandler) {
        return addItem(report, models, responseHandler, 'persistentStatus');
    };

    self.addPersistentItem = function(report, models, responseHandler) {
        return addItem(report, models, responseHandler, 'persistent');
    };

    self.addTransientItem = function(report, models, responseHandler, forceRun) {
        return addItem(report, models, responseHandler, 'transient', forceRun);
    };

    self.cancelAllItems = function() {
        var rq = runQueue;
        runQueue = [];
        while (rq.length > 0) {
            self.removeItem(rq.shift());
        }
    };

    self.cancelItem = function (qi) {
        if (! qi)
            return;
        qi.persistent = false;
        qi.qMode = 'transient';
        self.removeItem(qi);
    };

    self.removeItem = function(qi) {
        if (! qi)
            return;
        var qs = qi.qState;
        if (qs == 'removing')
            return;
        qi.qState = 'removing';
        var i = runQueue.indexOf(qi);
        if (i > -1)
            runQueue.splice(i, 1);
        cancelInterval(qi);
        if (qs == 'processing' && ! qi.persistent)
            requestSender.sendRequest('runCancel', null, qi.request);
    };

    $rootScope.$on('$routeChangeSuccess', self.cancelAllItems);
    $rootScope.$on('clearCache', self.cancelAllItems);

    return self;
});

SIREPO.app.factory('requestQueue', function($rootScope, requestSender) {
    var self = {};
    var queueMap = {};

    function getQueue(name) {
        if (! queueMap[name] ) {
            queueMap[name] = [];
        }
        return queueMap[name];
    }

    function sendNextItem(name) {
        var q = getQueue(name);
        if ( q.length <= 0 ) {
            return;
        }
        var qi = q[0];
        if ( qi.requestSent ) {
            return;
        }
        qi.requestSent = true;
        qi.params = qi.paramsCallback();
        var process = function(ok, resp, status) {
            if (qi.canceled) {
                sendNextItem(name);
                return;
            }
            q.shift();
            var cb = ok ? qi.params.successCallback : qi.params.errorCallback;
            if (cb) {
                cb(resp, status);
            }
            sendNextItem(name);
        };
        requestSender.sendRequest(
            qi.params.urlOrParams,
            function (resp, status) {process(true, resp, status);},
            qi.params.data,
            function (resp, status) {process(false, resp, status);}
        );
    }

    self.cancelItems = function(queueName) {
        var q = getQueue(queueName);
        q.forEach(function(qi) {qi.canceled = true;});
        q.length = 0;
    };

    self.addItem = function(queueName, paramsCallback) {
        getQueue(queueName).push({
            requestSent: false,
            paramsCallback: paramsCallback
        });
        sendNextItem(queueName);
    };
    return self;
});

SIREPO.app.factory('persistentSimulation', function(simulationQueue, appState, panelState, frameCache) {
    var self = {};
    self.initProperties = function(scope) {
        scope.frameId = '-1';
        scope.frameCount = 1;
        scope.isReadyForModelChanges = false;
        scope.simulationQueueItem = null;
        scope.dots = '.';
        scope.timeData = {
            elapsedDays: null,
            elapsedTime: null,
        };
        scope.panelState = panelState;

        function handleStatus(data) {
            setSimulationStatus(data);
            if (data.elapsedTime) {
                scope.timeData.elapsedDays = parseInt(data.elapsedTime / (60 * 60 * 24));
                scope.timeData.elapsedTime = new Date(1970, 0, 1);
                scope.timeData.elapsedTime.setSeconds(data.elapsedTime);
            }
            if (data.isStateProcessing) {
                scope.dots += '.';
                if (scope.dots.length > 3)
                    scope.dots = '.';
            }
            else {
                scope.simulationQueueItem = null;
            }
            scope.handleStatus(data);
        }

        function isState(state) {
            if (! appState.isLoaded())
                return false;
            for (var i = 1; i < arguments.length; i++)
                if (state == arguments[i])
                    return true;
            return false;
        }

        function runStatus() {
            scope.isReadyForModelChanges = true;
            scope.simulationQueueItem = simulationQueue.addPersistentStatusItem(
                scope.model,
                appState.models,
                handleStatus
            );
        }

        function setSimulationStatus(data) {
            if (!appState.models.simulationStatus)
                appState.models.simulationStatus = {};
            data.report = scope.model;
            appState.models.simulationStatus[scope.model] = data;
            if (appState.isLoaded()) {
                appState.saveChanges('simulationStatus');
            }
        }

        scope.simulationState = function() {
            return scope.simulationStatus().state;
        };

        scope.simulationStatus = function() {
            return appState.models.simulationStatus[scope.model] || {state: 'pending'};
        };

        scope.cancelSimulation = function() {
            setSimulationStatus({state: 'canceled'});
            simulationQueue.cancelItem(scope.simulationQueueItem);
            scope.simulationQueueItem = null;
        };

        scope.clearSimulation = function() {
            simulationQueue.removeItem(scope.simulationQueueItem);
            scope.simulationQueueItem = null;
        };

        scope.hasTimeData = function () {
            return scope.timeData && scope.timeData.elapsedTime !== null;
        };

        scope.isInitializing = function() {
            if (scope.isStateProcessing() && ! scope.isStatePending())
                return frameCache.getFrameCount() < 1;
            return false;
        };

        scope.isStatePending = function() {
            return scope.simulationStatus().state == 'pending';
        };

        scope.isStateProcessing = function() {
            return scope.simulationStatus().isStateProcessing;
        };

        scope.isStateRunning = function() {
            return scope.simulationStatus().state == 'running';
        };

        scope.isStateStopped = function() {
            return ! scope.isStateProcessing();
        };

        scope.runSimulation = function() {
            if (scope.isStateProcessing())
                //TODO(robnagler) this shouldn't happen? (double click?)
                return;
            //TODO(robnagler) should be part of simulationStatus
            frameCache.setFrameCount(0);
            scope.timeData.elapsedTime = null;
            scope.timeData.elapsedDays = null;
            setSimulationStatus({state: 'pending'});
            scope.simulationQueueItem = simulationQueue.addPersistentItem(
                scope.model,
                appState.models,
                handleStatus
            );
        };

        scope.stateAsText = function() {
            var s = scope.simulationState();
            var msg;
            msg = s.charAt(0).toUpperCase() + s.slice(1);
            if (s == 'error') {
                var e = scope.simulationStatus().error;
                if (e)
                    msg += ': ' + e.split(/[\n\r]+/)[0];
            }
            return msg;
        };

        scope.persistentSimulationInit = function($scope) {
            setSimulationStatus({state: 'stopped'});
            frameCache.setFrameCount(0);
            $scope.$on('$destroy', scope.clearSimulation);
            appState.whenModelsLoaded($scope, runStatus);
        };
    };
    return self;
});

// Exception logging from
// http://engineering.talis.com/articles/client-side-error-logging/
SIREPO.app.factory('traceService', function() {
    var self = {};
    self.printStackTrace = printStackTrace;
    return self;
});

SIREPO.app.provider('$exceptionHandler', {
    $get: function(exceptionLoggingService) {
        return exceptionLoggingService;
    }
});

SIREPO.app.factory('exceptionLoggingService', function($log, $window, traceService) {
    function error(exception, cause) {
        // preserve the default behaviour which will log the error
        // to the console, and allow the application to continue running.
        $log.error.apply($log, arguments);
        // now try to log the error to the server side.
        try{
            var message = exception ? String(exception) : '<no message>';
            cause = String(cause || '<no cause>');
            // use our traceService to generate a stack trace
            var stackTrace = traceService.printStackTrace({e: exception});
            // use AJAX (in this example jQuery) and NOT
            // an angular service such as $http
            $.ajax({
                type: 'POST',
                //url: localRoutes.errorLogging,
                url: '/error-logging',
                contentType: 'application/json',
                data: angular.toJson({
                    url: $window.location.href,
                    message: message,
                    type: 'exception',
                    stackTrace: stackTrace,
                    cause: cause,
                })
            });
        }
        catch (loggingError) {
            $log.warn('Error server-side logging failed');
            $log.log(loggingError);
        }
    }
    return error;
});

SIREPO.app.controller('NavController', function (activeSection, appState, requestSender, $window) {
    var self = this;

    function openSection(name, search) {
        requestSender.localRedirect(name, sectionParams(name), search);
    }

    function sectionParams(name) {
        if (requestSender.isRouteParameter(name, ':simulationId') && appState.isLoaded()) {
            return {
                ':simulationId': appState.models.simulation.simulationId,
            };
        }
        return {};
    }

    self.isActive = function(name) {
        return activeSection.getActiveSection() == name;
    };

    self.openSection = function(name) {
        if (name == 'simulations' && appState.isLoaded()) {
            appState.autoSave(function() {
                openSection(name, {
                    show_item_id: appState.models.simulation.simulationId,
                });
            });
        }
        else {
            openSection(name);
        }
    };

    self.pageTitle = function() {
        return $.grep(
            [
                self.sectionTitle(),
                SIREPO.APP_NAME.toUpperCase(),
                'Radiasoft',
            ],
            function(n){ return n; })
            .join(' - ');
    };

    self.revertToOriginal = function(applicationMode, name) {
        if (! appState.isLoaded())
            return;
        var url = requestSender.formatUrl(
            'findByName',
            {
                '<simulation_name>': name,
                '<simulation_type>': SIREPO.APP_SCHEMA.simulationType,
                '<application_mode>': applicationMode,
            });
        appState.deleteSimulation(
            appState.models.simulation.simulationId,
            function() {
                $window.location.href = url;
            });
    };

    self.sectionTitle = function() {
        if (appState.isLoaded())
            return appState.models.simulation.name;
        return null;
    };

    self.sectionURL = function(name) {
        return '#' + requestSender.formatUrlLocal(name, sectionParams(name));
    };
});

SIREPO.app.controller('NotFoundCopyController', function (requestSender, $route) {
    var self = this;
    var ids = $route.current.params.simulationIds.split('-');
    self.simulationId = ids[0];
    self.userCopySimulationId = ids[1];

    self.cancelButton = function() {
        requestSender.localRedirect('simulations');
    };

    self.copyButton = function() {
        requestSender.sendRequest(
            'copyNonSessionSimulation',
            function(data) {
                requestSender.localRedirect('source', {
                    ':simulationId': data.models.simulation.simulationId,
                });
            },
            {
                simulationId: self.simulationId,
                simulationType: SIREPO.APP_SCHEMA.simulationType,
            });
    };

    self.hasUserCopy = function() {
        return self.userCopySimulationId;
    };

    self.openButton = function() {
        requestSender.localRedirect('source', {
            ':simulationId': self.userCopySimulationId,
        });
    };
});

SIREPO.app.controller('SimulationsController', function (appState, panelState, requestSender, $location, $scope, $window) {
    var self = this;
    self.activeFolder = null;
    self.activeFolderPath = [];
    self.listColumns = [
        {
            field: 'name',
            heading: 'Name',
        },
        {
            field: 'lastModified',
            heading: 'Last Modified',
        }];
    //TODO(pjm): store view state in db preference or client cookie
    self.isIconView = true;
    self.fileTree = [];
    self.selectedItem = null;
    self.sortField = 'name';
    var showItemId = $location.search().show_item_id;

    function addToTree(item) {
        var path = item.folder == '/'
            ? []
            : item.folder.slice(1).split('/');
        var currentFolder = rootFolder();

        while (path.length) {
            var search = path.shift();
            var folder = null;
            for (var i = 0; i < currentFolder.children.length; i++) {
                if (search == currentFolder.children[i].name && currentFolder.children[i].isFolder) {
                    folder = currentFolder.children[i];
                    break;
                }
            }
            if (folder) {
                if (item.last_modified > folder.lastModified)
                    folder.lastModified = item.last_modified;
            }
            else {
                folder = {
                    name: search,
                    parent: currentFolder,
                    isFolder: true,
                    children: [],
                    lastModified: item.last_modified,
                };
                currentFolder.children.push(folder);
            }
            currentFolder = folder;
        }
        var newItem = {
            parent: currentFolder,
            name: item.name,
            simulationId: item.simulationId,
            lastModified: item.last_modified,
        };
        currentFolder.children.push(newItem);
        return newItem;
    }

    function clearModels() {
        appState.clearModels(appState.clone(SIREPO.appDefaultSimulationValues));
    }

    function folderList(excludeFolder, res, searchFolder) {
        if (! res) {
            searchFolder = rootFolder();
            res = [searchFolder];
        }
        for (var i = 0; i < searchFolder.children.length; i++) {
            var child = searchFolder.children[i];
            if (child.isFolder && child != excludeFolder) {
                res.push(child);
                folderList(excludeFolder, res, child);
            }
        }
        return res;
    }

    function loadList() {
        var showItem = null;
        appState.listSimulations(
            $location.search(),
            function(data) {
                data.sort(function(a, b) {
                    return a.last_modified.localeCompare(b.last_modified);
                });
                self.fileTree = [
                    {
                        name: '/',
                        isFolder: true,
                        children: [],
                    },
                ];
                for (var i = 0; i < data.length; i++) {
                    var item = addToTree(data[i]);
                    if (showItemId && (item.simulationId == showItemId))
                        showItem = item;
                }
                if (showItem)
                    self.openItem(showItem.parent);
                else
                    self.openItem(rootFolder());
            });
    }

    function removeItemFromFolder(item) {
        var parent = item.parent;
        parent.children.splice(parent.children.indexOf(item), 1);
    }

    function renameSelectedItem() {
        self.selectedItem.name = self.renameName;
    }

    function reparentSelectedItem(oldParent) {
        oldParent.children.splice(oldParent.children.indexOf(self.selectedItem), 1);
        self.selectedItem.parent = self.targetFolder;
        self.targetFolder.children.push(self.selectedItem);
        self.targetFolder = null;
    }

    function rootFolder() {
        return self.fileTree[0];
    }

    function setActiveFolder(item) {
        self.activeFolder = item;
        self.activeFolderPath = [];
        while (item) {
            self.activeFolderPath.unshift(item);
            item = item.parent;
        }
        appState.setActiveFolderPath(self.pathName(self.activeFolder));
    }

    function updateSelectedFolder(oldPath) {
        requestSender.sendRequest(
            'updateFolder',
            function() {
                self.selectedItem = null;
            },
            {
                oldName: oldPath,
                newName: self.pathName(self.selectedItem),
                simulationType: SIREPO.APP_SCHEMA.simulationType,
            });
    }

    function updateSelectedItem(op) {
        appState.loadModels(
            self.selectedItem.simulationId,
            function() {
                op();
                appState.saveQuietly('simulation');
                appState.autoSave(clearModels);
                self.selectedItem = null;
            });
    }

    self.canDelete = function(item) {
        if (item.isFolder)
            return item.children.length === 0;
        return true;
    };

    self.copyItem = function(item) {
        self.selectedItem = item;
        var names = {};
        for (var i = 0; i < self.activeFolder.children.length; i++) {
            names[self.activeFolder.children[i].name] = true;
        }
        var count = 2;
        var name = item.name;
        name = name.replace(/\s+\d+$/, '');
        while (names[name + ' ' + count])
            count++;
        self.copyName = name + ' ' + count;
        $('#s-copy-confirmation').modal('show');
    };

    self.copySelected = function() {
        appState.copySimulation(
            self.selectedItem.simulationId,
            function(data) {
                self.openItem(data.models.simulation);
            },
            self.copyName);
    };

    self.deleteItem = function(item) {
        if (item.isFolder)
            removeItemFromFolder(item);
        else {
            self.selectedItem = item;
            $('#s-delete-confirmation').modal('show');
        }
    };

    self.deleteSelected = function() {
        appState.deleteSimulation(
            self.selectedItem.simulationId,
            function() {
                removeItemFromFolder(self.selectedItem);
                self.selectedItem = null;
            });
    };

    self.isActiveFolder = function(item) {
        return item == self.activeFolder;
    };

    self.isRootFolder = function(item) {
        return item == rootFolder();
    };

    self.isSortAscending = function() {
        return self.sortField.charAt(0) != '-';
    };

    self.moveItem = function(item) {
        self.selectedItem = item;
        self.targetFolder = item.parent;
        self.moveFolderList = folderList(item);
        $('#s-move-confirmation').modal('show');
    };

    self.moveSelected = function() {
        var parent = self.selectedItem.parent;
        if (self.targetFolder == parent)
            return;
        if (self.selectedItem.isFolder) {
            var oldPath = self.pathName(self.selectedItem);
            reparentSelectedItem(parent);
            updateSelectedFolder(oldPath);
        }
        else {
            updateSelectedItem(function() {
                appState.models.simulation.folder = self.pathName(self.targetFolder);
                reparentSelectedItem(parent);
            });
        }
    };

    self.openItem = function(item) {
        if (item.isFolder) {
            item.isOpen = true;
            setActiveFolder(item);
            var current = item;
            while (current != rootFolder()) {
                current = current.parent;
                current.isOpen = true;
            }
        }
        else {
            requestSender.localRedirect('source', {
                ':simulationId': item.simulationId,
            });
        }
    };

    self.pathName = function(folder) {
        if (self.isRootFolder(folder))
            return '/';
        var path = '/' + folder.name;
        while (folder.parent != rootFolder()) {
            folder = folder.parent;
            path = '/' + folder.name + path;
        }
        return path;
    };

    self.pythonSource = function(item) {
        $window.open(requestSender.formatUrl('pythonSource', {
            '<simulation_id>': item.simulationId,
            '<simulation_type>': SIREPO.APP_SCHEMA.simulationType,
        }), '_blank');
    };

    self.renameItem = function(item) {
        self.selectedItem = item;
        self.renameName = item.name;
        $('#s-rename-confirmation').modal('show');
    };

    self.renameSelected = function() {
        if (! self.renameName || (self.renameName == self.selectedItem.name))
            return;
        if (self.selectedItem.isFolder) {
            var oldPath = self.pathName(self.selectedItem);
            renameSelectedItem();
            updateSelectedFolder(oldPath);
        }
        else {
            updateSelectedItem(function() {
                appState.models.simulation.name = self.renameName;
                renameSelectedItem();
            });
        }
    };

    self.selectedItemType = function(item) {
        if (self.selectedItem && self.selectedItem.isFolder)
            return 'Folder';
        return 'Simulation';
    };

    self.showSimulationModal = function() {
        panelState.showModalEditor('simulation');
    };

    self.toggleIconView = function() {
        self.isIconView = ! self.isIconView;
    };

    self.toggleFolder = function(item) {
        if (item == self.activeFolder)
            item.isOpen = ! item.isOpen;
        else {
            setActiveFolder(item);
            item.isOpen = true;
        }
    };

    self.toggleSort = function(field) {
        if (self.sortField.indexOf(field) >= 0) {
            self.sortField = self.isSortAscending() ? ('-' + field) : field;
        }
        else {
            self.sortField = field;
        }
    };

    clearModels();
    $scope.$on('simulation.changed', function() {
        appState.models.simulation.folder = self.pathName(self.activeFolder);
        appState.newSimulation(
            appState.models.simulation,
            function(data) {
                self.openItem(data.models.simulation);
            });
    });
    $scope.$on('simulationFolder.changed', function() {
        var name = appState.models.simulationFolder.name;
        name = name.replace(/[\/]/g, '');
        self.activeFolder.children.push({
            name: name,
            parent: self.activeFolder,
            isFolder: true,
            children: [],
        });
        appState.models.simulationFolder.name = '';
        appState.saveQuietly('simulationFolder');
    });
    loadList();
});
