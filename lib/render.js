const nunjucks = require('nunjucks');
const nodePath = require('path');
const fs = require('fs');
const _ = require('lodash');
const glob = require('glob');
const util = require('util');

const templates_path = nodePath.resolve(process.cwd(), 'templates');
const environment = new nunjucks.Environment(new nunjucks.FileSystemLoader(templates_path), {autoescape: false});

function clear_output_dir(output_path) {
    if (_.isNil(output_path)) {
        output_path = nodePath.resolve(process.cwd(), "output");
    }

    let file_paths = glob.sync(nodePath.resolve(output_path, "*.*"));
    _.each(file_paths, function (file_path) {
        fs.unlinkSync(file_path);
    });
}

function write_files(output_path, files) {
    if (_.isNil(output_path)) {
        output_path = nodePath.resolve(process.cwd(), "output");
    }

    fs.mkdirSync(output_path, {recursive: true});
    _.each(files, function (file) {
        fs.writeFileSync(nodePath.resolve(output_path, file.name), file.contents);
    })
}


function copy_base_files() {
    let extensions = ['tf', 'tfvars'];
    return _.map(extensions, function (extension) {
        let file_paths = glob.sync(nodePath.resolve(templates_path, `*.${extension}`));

        return _.map(file_paths, function (file_path) {
            return {
                name: nodePath.basename(file_path),
                contents: fs.readFileSync(file_path)
            };
        });

    });
}

function render_subnets(config) {
    let network_tiers = _.get(config, 'network_tiers');
    let availability_zones = _.get(config, 'availability_zones');

    return _.map(network_tiers, function (network_tier, network_tier_index) {
        let context = _.merge({}, {
            network_tier: _.get(network_tier, 'name'),
            public: _.get(network_tier, 'public'),
            network_tier_index: network_tier_index,
            availability_zones: availability_zones
        });

        let contents = environment.render("subnet.tf.jinja2", context);

        return {
            name: `subnets_${context.network_tier}_tier.tf`,
            contents: contents
        };

    });

}

function render_security_groups(config) {

    let grouped_expanded_network_traffic_rules = config.grouped_expanded_network_traffic_rules;

    let security_groups = [];

    // _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'rules', traffic_rule_direction, traffic_type.name, 'rules', traffic_rule_network_tier_type + 's', associated_network_tier.name], expanded_network_traffic_rule);
    _.each(grouped_expanded_network_traffic_rules, function (network_tier_group, network_tier_name) {
        let network_tier = network_tier_group.network_tier;

        let security_group_name = `${network_tier_name}_tier`;
        let security_group = {
            name: security_group_name,
            network_tier_name: network_tier_name,
            network_tier: network_tier
        };

        let rules = [];

        let network_tier_rules = network_tier_group.rules;

        _.each(network_tier_rules, function (traffic_rule_direction_rules, traffic_rule_direction) {
            _.each(traffic_rule_direction_rules, function (traffic_type_group, traffic_type_name) {
                let traffic_type = traffic_type_group.traffic_type;

                let traffic_type_rules = traffic_type_group.rules;

                if (_.has(traffic_type_rules, 'network_tiers')) {

                    let associated_network_tiers = _.sortedUniq(_.keys(traffic_type_rules.network_tiers));

                    _.each(associated_network_tiers, function (associated_network_tier_name) {
                        let rule = {
                            name: `${network_tier_name}_${traffic_type_name}_${traffic_rule_direction === 'ingress' ? 'ingress_from' : 'egress_to'}_${associated_network_tier_name}`,
                            type: traffic_rule_direction,
                            traffic_type_name: traffic_type_name,
                            traffic_type: traffic_type,
                            port: _.get(traffic_type, 'port'),
                            protocol: _.get(traffic_type, 'protocol'),
                            network_tier: associated_network_tier_name,
                        };
                        rules.push(rule);
                    });
                } else if (_.has(traffic_type_rules, 'cidr_blocks')) {
                    let cidr_blocks = _.sortedUniq(_.uniq(_.map(traffic_type_rules.cidr_blocks, 'cidr_block')));
                    let rule = {
                        name: `${network_tier_name}_${traffic_type_name}_${traffic_rule_direction === 'ingress' ? 'ingress_from' : 'egress_to'}_cidr_blocks`,
                        type: traffic_rule_direction,
                        traffic_type_name: traffic_type_name,
                        traffic_type: traffic_type,
                        port: _.get(traffic_type, 'port'),
                        protocol: _.get(traffic_type, 'protocol'),
                        cidr_blocks: cidr_blocks,

                    };
                    rules.push(rule);
                }

            });
        });

        security_group.rules = rules;

        security_groups.push(security_group);
    });

    debug_log(security_groups);

    return _.map(security_groups, function (security_group) {
        let context = _.merge({}, security_group);

        let contents = environment.render("security_group.tf.jinja2", context);

        return {name: `security_group_${context.name}.tf`, contents: contents};
    });
}


function render_network_acls(config) {

    let grouped_expanded_network_traffic_rules = config.grouped_expanded_network_traffic_rules;
    let availability_zones = _.get(config, 'availability_zones');

    let network_acls = [];

    // _.set(grouped_expanded_network_traffic_rules, [network_tier.name, 'rules', traffic_rule_direction, traffic_type.name, 'rules', traffic_rule_network_tier_type + 's', associated_network_tier.name], expanded_network_traffic_rule);
    _.each(grouped_expanded_network_traffic_rules, function (network_tier_group, network_tier_name) {
        let network_tier = network_tier_group.network_tier;

        let network_acl_name = `${network_tier_name}_tier`;
        let network_acl = {
            name: network_acl_name,
            network_tier_name: network_tier_name,
            network_tier: network_tier,
            availability_zones: availability_zones
        };

        let rules = [];

        let network_tier_rules = network_tier_group.rules;

        _.each(network_tier_rules, function (traffic_rule_direction_rules, traffic_rule_direction) {
            _.each(traffic_rule_direction_rules, function (traffic_type_group, traffic_type_name) {
                let traffic_type = traffic_type_group.traffic_type;

                let traffic_type_rules = traffic_type_group.rules;

                let cidr_blocks = _.sortedUniq(_.uniq(_.map(_.concat(traffic_type_rules.network_tiers, traffic_type_rules.cidr_blocks), 'cidr_blocks')));

                let rule = {
                    name: `${network_tier_name}_${traffic_type_name}_${traffic_rule_direction === 'ingress' ? 'ingress_from' : 'egress_to'}_cidr_blocks`,
                    type: traffic_rule_direction,
                    traffic_type_name: traffic_type_name,
                    traffic_type: traffic_type,
                    cidr_blocks: cidr_blocks,
                    network_tier_name: network_tier_name,
                    egress: traffic_rule_direction === 'egress',
                    port: _.get(traffic_type, 'port'),
                    protocol: _.get(traffic_type, 'protocol'),

                };
                rules.push(rule);

            });
        });

        network_acl.rules = rules;

        network_acls.push(network_acl);
    });


    debug_log(network_acls);

    return _.map(network_acls, function (network_acl) {
        let context = _.merge({}, network_acl);

        let contents = environment.render("network_acl.tf.jinja2", context);

        return {name: `network_acl_${context.name}.tf`, contents: contents};
    });
}


function render_internet_gateway(config) {
    let network_tiers = _.get(config, 'network_tiers');
    let availability_zones = _.get(config, 'availability_zones');

    let context = {};
    context.public_network_tiers = _.map(_.filter(network_tiers, {public: true}), 'name');
    context.availability_zones = availability_zones;

    let contents = environment.render("internet_gateway.tf.jinja2", context);

    return {name: 'internet_gateway.tf', contents: contents};
}


function render_nat_gateways(config) {
    let network_tiers = _.get(config, 'network_tiers');
    let availability_zones = _.get(config, 'availability_zones');

    let context = {};
    context.public_network_tiers = _.map(_.filter(network_tiers, {public: true}), 'name');
    context.public_network_tiers = _.map(_.filter(network_tiers, {public: false}), 'name');
    context.availability_zones = availability_zones;
    context.public_network_tier = _.first(context.public_network_tiers);

    let contents = environment.render("nat_gateways.tf.jinja2", context);

    return {name: 'nat_gateways.tf', contents: contents};
}


function render_main(config) {
    let region = _.get(config, 'region');

    let context = {};
    context.region = region;

    let contents = environment.render("main.tf.jinja2", context);

    return {name: 'main.tf', contents: contents};
}


function render_traffic_rules_dot(config) {
    let network_tiers = _.concat(_.get(config, 'network_tiers'), _.get(config, 'known_cidr_ranges'));
    let network_traffic_rules = _.get(config, 'network_traffic_rules');

    let context = {
        network_tiers: network_tiers,
        network_traffic_rules: network_traffic_rules,
    };

    let contents = environment.render("traffic_rules.dot.jinja2", context);

    return {name: 'traffic_rules.dot', contents: contents};

}


module.exports = {
    clear_output_dir: clear_output_dir,
    copy_base_files: copy_base_files,
    render_subnets: render_subnets,
    render_network_acls: render_network_acls,
    render_security_groups: render_security_groups,
    render_internet_gateway: render_internet_gateway,
    render_nat_gateways: render_nat_gateways,
    render_main: render_main,
    render_traffic_rules_dot: render_traffic_rules_dot,
    render: render
};


function debug_log(obj) {
    console.error(util.inspect(obj, {showHidden: false, depth: null}))
}


function render(config, output_path) {
    if (_.isNil(output_path)) {
        output_path = nodePath.resolve(process.cwd(), "output");
    }

    clear_output_dir(output_path);

    let files = [];

    files.push(copy_base_files());
    files.push(render_main(config));
    files.push(render_subnets(config));
    files.push(render_network_acls(config));
    files.push(render_security_groups(config));
    files.push(render_internet_gateway(config));
    files.push(render_nat_gateways(config));
    files.push(render_traffic_rules_dot(config));

    files = _.flattenDeep(files);
    write_files(output_path, _.flattenDeep(files));
}
