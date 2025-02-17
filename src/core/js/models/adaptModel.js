define([
    'core/js/adapt',
    'core/js/modelEvent',
    'core/js/logging'
], function (Adapt, ModelEvent) {

    var AdaptModel = Backbone.Model.extend({

        defaults: {
            _canShowFeedback: true,
            _classes: "",
            _canReset: false,
            _isComplete: false,
            _isInteractionComplete: false,
            _isA11yRegionEnabled: false,
            _isA11yCompletionDescriptionEnabled: true,
            _requireCompletionOf: -1,
            _isEnabled: true,
            _isResetOnRevisit: false,
            _isAvailable: true,
            _isOptional: false,
            _isReady: false,
            _isVisible: true,
            _isLocked: false,
            _isHidden: false
        },

        trackable: [
            '_id',
            '_isComplete',
            '_isInteractionComplete'
        ],

        bubblingEvents: [
            'change:_isComplete',
            'change:_isInteractionComplete'
        ],

        initialize: function () {
            // Wait until data is loaded before setting up model
            this.listenToOnce(Adapt, 'app:dataLoaded', this.setupModel);

        },

        setupModel: function() {
            if (this.get('_type') === 'page') {
                this._children = 'articles';
            }
            if (this._siblings === 'contentObjects' && this.get('_parentId') !== Adapt.course.get('_id')) {
                this._parent = 'contentObjects';
            }
            if (this._children) {
                this.setupChildListeners();
            }

            this.init();

            _.defer(function() {
                if (this._children) {
                    this.checkCompletionStatus();

                    this.checkInteractionCompletionStatus();

                    this.checkLocking();
                }

                this.setupTrackables();

            }.bind(this));

        },
        
        getIsAvailableInPage: function() {
            var isAvailable = this.get('_isAvailable');
            if (!isAvailable) {
              return false;
            }
            var parent = this;
            while (parent = parent.getParent()) {
              var type = parent.get('_type');
              if (type === 'menu' || type === 'page') {
                 // do not check beyond page / menu parents
                 return true;
              }
              isAvailable = parent.get('_isAvailable');
              if (!isAvailable) {
                return false;
              }
            }
            return true;
        },

        setupTrackables: function() {

            // Limit state trigger calls and make state change callbacks batched-asynchronous
            var originalTrackableStateFunction = this.triggerTrackableState;
            this.triggerTrackableState = _.compose(
                function() {

                    // Flag that the function is awaiting trigger
                    this.triggerTrackableState.isQueued = true;

                }.bind(this),
                _.debounce(function() {

                    // Trigger original function
                    originalTrackableStateFunction.apply(this);

                    // Unset waiting flag
                    this.triggerTrackableState.isQueued = false;

                }.bind(this), 17)
            );

            // Listen to model changes, trigger trackable state change when appropriate
            this.listenTo(this, "change", function(model, value) {

                // Skip if trigger queued or adapt hasn't started yet
                if (this.triggerTrackableState.isQueued || !Adapt.attributes._isStarted) {
                    return;
                }

                // Check that property is trackable
                var trackablePropertyNames = _.result(this, 'trackable', []);
                var changedPropertyNames = _.keys(model.changed);
                var isTrackable = _.find(changedPropertyNames, function(item, index) {
                    return _.contains(trackablePropertyNames, item);
                }.bind(this));

                if (isTrackable) {
                    // Trigger trackable state change
                    this.triggerTrackableState();
                }
            });
        },

        setupChildListeners: function() {
            var children = this.getChildren();
            if (!children.length) {
                return;
            }

            this.listenTo(children, {
                "all": this.onAll,
                "bubble": this.bubble,
                "change:_isReady": this.checkReadyStatus,
                "change:_isComplete": this.onIsComplete,
                "change:_isInteractionComplete": this.checkInteractionCompletionStatus
            });
        },

        init: function() {},

        getTrackableState: function() {

            var trackable = this.resultExtend("trackable", []);
            var json = this.toJSON();

            var args = trackable;
            args.unshift(json);

            return _.pick.apply(_, args);

        },

        setTrackableState: function(state) {

            var trackable = this.resultExtend("trackable", []);

            var args = trackable;
            args.unshift(state);

            state = _.pick.apply(_, args);

            this.set(state);

            return this;

        },

        triggerTrackableState: function() {

            Adapt.trigger("state:change", this, this.getTrackableState());

        },

        reset: function(type, force) {
            if (!this.get("_canReset") && !force) return;

            type = type || true;

            switch (type) {
            case "hard": case true:
                this.set({
                    _isEnabled: true,
                    _isComplete: false,
                    _isInteractionComplete: false
                });
                break;
            case "soft":
                this.set({
                    _isEnabled: true,
                    _isInteractionComplete: false
                });
                break;
            }
        },

        checkReadyStatus: function () {
            // Filter children based upon whether they are available
            // Check if any return _isReady:false
            // If not - set this model to _isReady: true
            var children = this.getAvailableChildModels();
            if (_.find(children, function(child) { return child.get('_isReady') === false; })) {
                return;
            }

            this.set('_isReady', true);
        },

        setCompletionStatus: function() {
            if (!this.get('_isVisible')) return;

            this.set({
                _isComplete: true,
                _isInteractionComplete: true
            });
        },

        checkCompletionStatus: function () {
            //defer to allow other change:_isComplete handlers to fire before cascading to parent
            Adapt.checkingCompletion();
            _.defer(this.checkCompletionStatusFor.bind(this), '_isComplete');
        },

        checkInteractionCompletionStatus: function () {
            //defer to allow other change:_isInteractionComplete handlers to fire before cascading to parent
            Adapt.checkingCompletion();
            _.defer(this.checkCompletionStatusFor.bind(this), '_isInteractionComplete');
        },

        /**
         * Function for checking whether the supplied completion attribute should be set to true or false.
         * It iterates over our immediate children, checking the same completion attribute on any mandatory child
         * to see if enough/all of them them have been completed. If enough/all have, we set our attribute to true;
         * if not, we set it to false.
         * @param {string} [completionAttribute] Either "_isComplete" or "_isInteractionComplete". Defaults to "_isComplete" if not supplied.
         */
        checkCompletionStatusFor: function(completionAttribute) {
            if (!completionAttribute) completionAttribute = "_isComplete";

            var completed = false;
            var children = this.getAvailableChildModels();
            var requireCompletionOf = this.get("_requireCompletionOf");

            if (requireCompletionOf === -1) { // a value of -1 indicates that ALL mandatory children must be completed
                completed = (_.find(children, function(child) {
                    return !child.get(completionAttribute) && !child.get('_isOptional');
                }) === undefined);
            } else {
                completed = (_.filter(children, function(child) {
                    return child.get(completionAttribute) && !child.get('_isOptional');
                }).length >= requireCompletionOf);
            }

            this.set(completionAttribute, completed);

            Adapt.checkedCompletion();
        },

        /**
         * Searches the model's ancestors to find the first instance of the specified ancestor type
         * @param {string} [ancestorType] Valid values are 'course', 'pages', 'contentObjects', 'articles' or 'blocks'.
         * If left blank, the immediate ancestor (if there is one) is returned
         * @return {object} Reference to the model of the first ancestor of the specified type that's found - or `undefined` if none found
         */
        findAncestor: function (ancestorType) {
            var parent = this.getParent();
            if (!parent) return;

            if (ancestorType === 'pages') {
                ancestorType = 'contentObjects';
            }

            if (!ancestorType || this._parent === ancestorType) {
                return parent;
            }

            return parent.findAncestor(ancestorType);
        },

        /**
         * Returns all the descendant models of a specific type
         * @param {string} descendants Valid values are 'contentObjects', 'pages', 'menus', 'articles', 'blocks' or 'components'
         * @param {object} options an object that defines the search type and the properties/values to search on. Currently only the `where` search type (equivalent to `Backbone.Collection.where()`) is supported.
         * @param {object} options.where
         * @return {array}
         * @example
         * //find all available, non-optional components
         * this.findDescendantModels('components', { where: { _isAvailable: true, _isOptional: false }});
         */
        findDescendantModels: function(descendants, options) {

            var types = [
                descendants.slice(0, -1)
            ];
            if (descendants === 'contentObjects') {
                types.push.apply(types, ['page', 'menu']);
            }

            var allDescendantsModels = this.getAllDescendantModels();
            var returnedDescendants = allDescendantsModels.filter(function(model) {
                return _.contains(types, model.get("_type"));
            });

            if (!options) {
                return returnedDescendants;
            }

            if (options.where) {
                return returnedDescendants.filter(function(descendant) {
                    for (var property in options.where) {
                        var value = options.where[property];
                        if (descendant.get(property) !== value) {
                            return false;
                        }
                    }
                    return true;
                });
            }
        },

        /**
         * Fetches the sub structure of a model as a flattened array
         *
         * Such that the tree:
         *  { a1: { b1: [ c1, c2 ], b2: [ c3, c4 ] }, a2: { b3: [ c5, c6 ] } }
         *
         * will become the array (parent first = false):
         *  [ c1, c2, b1, c3, c4, b2, a1, c5, c6, b3, a2 ]
         *
         * or (parent first = true):
         *  [ a1, b1, c1, c2, b2, c3, c4, a2, b3, c5, c6 ]
         *
         * This is useful when sequential operations are performed on the menu/page/article/block/component hierarchy.
         * @param {boolean} [isParentFirst]
         * @return {array}
         */
        getAllDescendantModels: function(isParentFirst) {

            var descendants = [];

            if (this.get("_type") === "component") {
                descendants.push(this);
                return descendants;
            }

            var children = this.getChildren();

            for (var i = 0, l = children.models.length; i < l; i++) {

                var child = children.models[i];
                if (child.get("_type") === "component") {

                    descendants.push(child);
                    continue;

                }

                var subDescendants = child.getAllDescendantModels(isParentFirst);
                if (isParentFirst === true) {
                    descendants.push(child);
                }

                descendants = descendants.concat(subDescendants);

                if (isParentFirst !== true) {
                    descendants.push(child);
                }

            }

            return descendants;

        },

        /**
         * @deprecated Since v2.2.0 - please use findDescendantModels instead
         */
        findDescendants: function (descendants) {
            Adapt.log.warn("DEPRECATED - Use findDescendantModels() as findDescendants() may be removed in the future");

            // first check if descendant is child and return child
            if (this._children === descendants) {
                return this.getChildren();
            }

            var allDescendants = [];
            var flattenedDescendants;
            var children = this.getChildren();
            var returnedDescendants;

            function searchChildren(children) {
                var models = children.models;
                for (var i = 0, len = models.length; i < len; i++) {
                    var model = models[i];
                    var childrensModels = model.getChildren().models;
                    allDescendants.push(childrensModels);
                    flattenedDescendants = _.flatten(allDescendants);
                }

                returnedDescendants = new Backbone.Collection(flattenedDescendants);

                if (children.models.length === 0 || children.models[0]._children === descendants) {
                    return;
                } else {
                    allDescendants = [];
                    searchChildren(returnedDescendants);
                }
            }

            searchChildren(children);

            // returns a collection of children
            return returnedDescendants;
        },

        /**
         * Returns a relative model from the Adapt hierarchy
         *
         * Such that in the tree:
         *  { a1: { b1: [ c1, c2 ], b2: [ c3, c4 ] }, a2: { b3: [ c5, c6 ] } }
         *
         *  c1.findRelativeModel("@block +1") = b2;
         *  c1.findRelativeModel("@component +4") = c5;
         *
         * @see Adapt.parseRelativeString for a description of relativeStrings
         * @param {string} relativeString
         * @param {object} options Search configuration settings
         * @param {boolean} options.limitParentId
         * @param {function} options.filter
         * @param {boolean} options.loop
         * @return {array}
         */
        findRelativeModel: function(relativeString, options) {

            var types = [ "menu", "page", "article", "block", "component" ];

            options = options || {};

            var modelId = this.get("_id");
            var modelType = this.get("_type");

            // return a model relative to the specified one if opinionated
            var rootModel = Adapt.course;
            if (options.limitParentId) {
                rootModel = Adapt.findById(options.limitParentId);
            }

            var relativeDescriptor = Adapt.parseRelativeString(relativeString);

            var findAncestorType = (_.indexOf(types, modelType) > _.indexOf(types, relativeDescriptor.type));
            var findSiblingType = (modelType === relativeDescriptor.type);

            var searchBackwards = (relativeDescriptor.offset < 0);
            var moveBy = Math.abs(relativeDescriptor.offset);
            var movementCount = 0;

            var findDescendantType = (!findSiblingType && !findAncestorType);

            if (findDescendantType) {
                // move by one less as first found is considered next
                moveBy--;
            }

            var pageDescendants;
            if (searchBackwards) {
                // parents first [p1,a1,b1,c1,c2,a2,b2,c3,c4,p2,a3,b3,c6,c7,a4,b4,c8,c9]
                pageDescendants = rootModel.getAllDescendantModels(true);

                // reverse so that we don't need a forward and a backward iterating loop
                // reversed [c9,c8,b4,a4,c7,c6,b3,a3,p2,c4,c3,b2,a2,c2,c1,b1,a1,p1]
                pageDescendants.reverse();
            } else {
                // children first [c1,c2,b1,a1,c3,c4,b2,a2,p1,c6,c7,b3,a3,c8,c9,b4,a4,p2]
                pageDescendants = rootModel.getAllDescendantModels(false);
            }

            // filter if opinionated
            if (typeof options.filter === "function") {
                pageDescendants = _.filter(pageDescendants, options.filter);
            }

            // find current index in array
            var modelIndex = _.findIndex(pageDescendants, function(pageDescendant) {
                if (pageDescendant.get("_id") === modelId) {
                    return true;
                }
                return false;
            });

            if (options.loop) {

                // normalize offset position to allow for overflow looping
                var typeCounts = {};
                pageDescendants.forEach(function(model) {
                    var type = model.get("_type");
                    typeCounts[type] = typeCounts[type] || 0;
                    typeCounts[type]++;
                });
                moveBy = moveBy % typeCounts[relativeDescriptor.type];

                // double up entries to allow for overflow looping
                pageDescendants = pageDescendants.concat(pageDescendants.slice(0));

            }

            for (var i = modelIndex, l = pageDescendants.length; i < l; i++) {
                var descendant = pageDescendants[i];
                if (descendant.get("_type") === relativeDescriptor.type) {
                    if (movementCount === moveBy) {
                        return Adapt.findById(descendant.get("_id"));
                    }
                    movementCount++;
                }
            }

            return undefined;
        },

        getChildren: function () {
            if (this.get("_children")) return this.get("_children");

            var childrenCollection;

            if (!this._children) {
                childrenCollection = new Backbone.Collection();
            } else {
                var children = Adapt[this._children].where({_parentId: this.get("_id")});
                childrenCollection = new Backbone.Collection(children);
            }

            if (this.get('_type') == 'block' &&
                childrenCollection.length == 2 &&
                childrenCollection.models[0].get('_layout') !== 'left' &&
                this.get('_sortComponents') !== false) {
                // Components may have a 'left' or 'right' _layout,
                // so ensure they appear in the correct order
                // Re-order component models to correct it
                childrenCollection.comparator = '_layout';
                childrenCollection.sort();
            }

            this.set("_children", childrenCollection);

            return childrenCollection;
        },

        getAvailableChildModels: function() {
            return this.getChildren().where({
                _isAvailable: true
            });
        },

        /**
         * @deprecated since v2.2.0 please use getAvailableChildModels instead
         */
        getAvailableChildren: function() {
            Adapt.log.warn("DEPRECATED - Use getAvailableChildModels() as getAvailableChildren() may be removed in the future");

            return new Backbone.Collection(this.getChildren().where({
                _isAvailable: true
            }));
        },

        getParent: function () {
            if (this.get("_parent")) return this.get("_parent");
            if (this._parent === "course") {
                return Adapt.course;
            }
            var parent = Adapt.findById(this.get("_parentId"));
            this.set("_parent", parent);

            // returns a parent model
            return parent;
        },

        getAncestorModels: function(shouldIncludeChild) {
            var parents = [];
            var context = this;

            if (shouldIncludeChild) parents.push(context);

            while (context.has("_parentId")) {
                context = context.getParent();
                parents.push(context);
            }

            return parents.length ? parents : null;
        },

        /**
         * @deprecated since v2.2.0 please use getAncestorModels instead
         */
        getParents: function(shouldIncludeChild) {
            Adapt.log.warn("DEPRECATED - Use getAncestorModels() as getParents() may be removed in the future");

            var parents = [];
            var context = this;

            if (shouldIncludeChild) parents.push(context);

            while (context.has("_parentId")) {
                context = context.getParent();
                parents.push(context);
            }

            return parents.length ? new Backbone.Collection(parents) : null;
        },

        getSiblings: function (passSiblingsAndIncludeSelf) {
            var siblings;
            if (!passSiblingsAndIncludeSelf) {
                // returns a collection of siblings excluding self
                if (this._hasSiblingsAndSelf === false) {
                    return this.get("_siblings");
                }
                siblings = _.reject(Adapt[this._siblings].where({
                    _parentId: this.get('_parentId')
                }), function (model) {
                    return model.get('_id') == this.get('_id');
                }.bind(this));

                this._hasSiblingsAndSelf = false;

            } else {
                // returns a collection of siblings including self
                if (this._hasSiblingsAndSelf) {
                    return this.get("_siblings");
                }

                siblings = Adapt[this._siblings].where({
                    _parentId: this.get("_parentId")
                });
                this._hasSiblingsAndSelf = true;
            }

            var siblingsCollection = new Backbone.Collection(siblings);
            this.set("_siblings", siblingsCollection);
            return siblingsCollection;
        },

        setOnChildren: function (key, value, options) {

            var args = arguments;

            this.set.apply(this, args);

            if (!this._children) return;

            var children = this.getChildren();
            var models = children.models;
            for (var i = 0, len = models.length; i < len; i++) {
                var child = models[i];
                child.setOnChildren.apply(child, args);
            }

        },

        /**
         * @deprecated since v3.2.3 - please use `model.set('_isOptional', value)` instead
         */
        setOptional: function(value) {
            this.set({_isOptional: value});
        },

        checkLocking: function() {
            var lockType = this.get("_lockType");

            if (!lockType) return;

            switch (lockType) {
                case "sequential":
                    this.setSequentialLocking();
                    break;
                case "unlockFirst":
                    this.setUnlockFirstLocking();
                    break;
                case "lockLast":
                    this.setLockLastLocking();
                    break;
                case "custom":
                    this.setCustomLocking();
                    break;
                default:
                    console.warn("AdaptModel.checkLocking: unknown _lockType \"" +
                        lockType + "\" found on " + this.get("_id"));
            }
        },

        setSequentialLocking: function() {
            var children = this.getAvailableChildModels();

            for (var i = 1, j = children.length; i < j; i++) {
                children[i].set("_isLocked", !children[i - 1].get("_isComplete"));
            }
        },

        setUnlockFirstLocking: function() {
            var children = this.getAvailableChildModels();
            var isFirstChildComplete = children[0].get("_isComplete");

            for (var i = 1, j = children.length; i < j; i++) {
                children[i].set("_isLocked", !isFirstChildComplete);
            }
        },

        setLockLastLocking: function() {
            var children = this.getAvailableChildModels();
            var lastIndex = children.length - 1;

            for (var i = lastIndex - 1; i >= 0; i--) {
                if (!children[i].get("_isComplete")) {
                    return children[lastIndex].set("_isLocked", true);
                }
            }

            children[lastIndex].set("_isLocked", false);
        },

        setCustomLocking: function() {
            var children = this.getAvailableChildModels();

            for (var i = 0, j = children.length; i < j; i++) {
                var child = children[i];

                child.set("_isLocked", this.shouldLock(child));
            }
        },

        shouldLock: function(child) {
            var lockedBy = child.get("_lockedBy");

            if (!lockedBy) return false;

            for (var i = lockedBy.length - 1; i >= 0; i--) {
                var id = lockedBy[i];

                try {
                    var model = Adapt.findById(id);

                    if (!model.get("_isAvailable")) continue;
                    if (!model.get("_isComplete")) return true;
                }
                catch (e) {
                    console.warn("AdaptModel.shouldLock: unknown _lockedBy ID \"" + id +
                        "\" found on " + child.get("_id"));
                }
            }

            return false;
        },

        onIsComplete: function() {
            this.checkCompletionStatus();
            this.checkLocking();
        },

        /**
         * Internal event handler for all module events. Triggers event bubbling
         * through the module hierarchy when the event is included in
         * `this.bubblingEvents`.
         * @param {string} type Event name / type
         * @param {Backbone.Model} model Origin backbone model
         * @param {*} value New property value
         */
        onAll: function(type, model, value) {
            if (!_.contains(this.bubblingEvents, type)) return;
            var event = new ModelEvent(type, model, value);
            this.bubble(event);
        },

        /**
         * Internal event handler for bubbling events.
         * @param {ModelEvent} event
         */
        bubble: function(event) {
            if (!event.canBubble) return;
            event.addPath(this);
            this.trigger("bubble:" + event.type + " bubble", event);
        }

    });

    return AdaptModel;

});
